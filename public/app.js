// ==========================================
// Watch Together — Full Client Application
// ==========================================

const socket = io();

// ==========================================
// UTILITY: Toast Notifications
// ==========================================
function showToast(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
        success: '✅',
        error: '❌',
        info: 'ℹ️',
        warning: '⚠️'
    };

    toast.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ==========================================
// ROOM MANAGEMENT
// ==========================================
const roomId = window.location.pathname.split('/').pop();
document.getElementById('roomIdDisplay').innerText = roomId;
// join-room is called inside startMedia() to prevent camera sync issues

// Connection Status
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

socket.on('connect', () => {
    statusDot.className = 'status-dot connected';
    statusText.innerText = 'เชื่อมต่อแล้ว';
    showToast('เชื่อมต่อสำเร็จ!', 'success');
});

socket.on('disconnect', () => {
    statusDot.className = 'status-dot disconnected';
    statusText.innerText = 'ขาดการเชื่อมต่อ';
    showToast('ขาดการเชื่อมต่อ กำลังเชื่อมใหม่...', 'error');
});

socket.on('reconnect', () => {
    socket.emit('join-room', roomId);
    showToast('เชื่อมต่อใหม่สำเร็จ!', 'success');
});

// User Count
socket.on('user-count', (count) => {
    document.getElementById('userCount').innerText = count;
    if (count >= 2) {
        showToast('แฟนเข้าห้องมาแล้ว! 💕', 'success');
    }
});

// Copy Room Link
document.getElementById('copyRoomBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
        showToast('คัดลอกลิงก์ห้องแล้ว!', 'success', 2000);
    }).catch(() => {
        // Fallback
        const input = document.createElement('input');
        input.value = window.location.href;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        showToast('คัดลอกลิงก์ห้องแล้ว!', 'success', 2000);
    });
});

// ==========================================
// 1. YOUTUBE IFRAME API
// ==========================================
let player;
let isSyncing = false;
let playerReady = false;
const playerLoading = document.getElementById('playerLoading');

window.onYouTubeIframeAPIReady = function () {
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        playerVars: {
            autoplay: 0,
            controls: 1,
            rel: 0,
            modestbranding: 1,
            iv_load_policy: 3,
            origin: window.location.origin
        },
        events: {
            onReady: onPlayerReady,
            onStateChange: onPlayerStateChange,
            onError: onPlayerError
        }
    });
};

function onPlayerReady(event) {
    playerReady = true;
    playerLoading.classList.add('fade-out');
    setTimeout(() => playerLoading.classList.add('hidden'), 500);

    // Set volume from slider
    const vol = document.getElementById('volumeSlider').value;
    player.setVolume(vol);

    // Request sync state (for late joiners)
    socket.emit('request-sync');
}

function onPlayerStateChange(event) {
    if (isSyncing) return;

    const time = player.getCurrentTime();

    switch (event.data) {
        case YT.PlayerState.PLAYING:
            socket.emit('video-play', time);
            break;
        case YT.PlayerState.PAUSED:
            socket.emit('video-pause', time);
            break;
        case YT.PlayerState.ENDED:
            const videoData = player.getVideoData();
            if (videoData && videoData.video_id) {
                socket.emit('video-ended', videoData.video_id);
            }
            break;
    }
}

function onPlayerError(event) {
    const errors = {
        2: 'URL วิดีโอไม่ถูกต้อง',
        5: 'ไม่สามารถเล่นวิดีโอนี้ใน HTML5 player',
        100: 'ไม่พบวิดีโอนี้',
        101: 'เจ้าของวิดีโอไม่อนุญาตให้เล่นแบบ embed',
        150: 'เจ้าของวิดีโอไม่อนุญาตให้เล่นแบบ embed'
    };
    showToast(errors[event.data] || 'เกิดข้อผิดพลาดในการเล่นวิดีโอ', 'error');
}

// Seek detection via polling
let lastKnownTime = 0;
setInterval(() => {
    if (!player || !playerReady || isSyncing) return;
    try {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PLAYING) {
            const currentTime = player.getCurrentTime();
            const diff = Math.abs(currentTime - lastKnownTime);
            // If time jumped more than 2 seconds, it's a seek
            if (lastKnownTime > 0 && diff > 2) {
                socket.emit('video-seek', currentTime);
            }
            lastKnownTime = currentTime;
        }
    } catch (e) { /* player not ready */ }
}, 500);

// Auto-Sync on Buffer heartbeat
setInterval(() => {
    if (!player || !playerReady || isSyncing) return;
    try {
        if (player.getPlayerState() === YT.PlayerState.PLAYING) {
            socket.emit('check-sync', player.getCurrentTime());
        }
    } catch (e) {}
}, 5000);

// ==========================================
// SEARCH
// ==========================================
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const searchBtn = document.getElementById('searchBtn');
const searchBtnText = document.getElementById('searchBtnText');
const searchSpinner = document.getElementById('searchSpinner');

searchBtn.addEventListener('click', performSearch);
searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') performSearch();
});

document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-container')) {
        searchResults.classList.add('hidden');
    }
});

async function performSearch() {
    const query = searchInput.value.trim();
    if (!query) return;

    // Check if it's a direct URL
    if (query.includes('youtube.com') || query.includes('youtu.be')) {
        let videoId = null;
        // Robust regex to extract YouTube ID from any format
        const match = query.match(/(?:youtu\.be\/|youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
        
        if (match && match[1]) {
            videoId = match[1];
        } else {
            showToast('URL ไม่ถูกต้องหรือไม่รองรับ', 'error');
            return;
        }

        if (player && videoId) {
            player.loadVideoById(videoId);
            socket.emit('video-load', videoId);
            showToast('กำลังโหลดวิดีโอ...', 'info', 2000);
        }
        searchResults.classList.add('hidden');
        searchInput.value = '';
        return;
    }

    // API search
    searchBtnText.classList.add('hidden');
    searchSpinner.classList.remove('hidden');
    searchBtn.disabled = true;

    try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
            headers: {
                'Bypass-Tunnel-Reminder': 'true' // For localtunnel bypass
            }
        });
        if (!response.ok) throw new Error('Search failed');
        const videos = await response.json();

        searchResults.innerHTML = '';
        if (videos.length === 0) {
            searchResults.innerHTML = '<div style="padding:16px;color:var(--text-muted);text-align:center;">ไม่พบผลลัพธ์</div>';
        } else {
            videos.forEach(video => {
                const item = document.createElement('div');
                item.className = 'search-item';
                item.innerHTML = `
                    <img class="search-thumb" src="${video.thumbnail}" alt="" loading="lazy">
                    <div class="search-info">
                        <div class="search-title">${escapeHtml(video.title)}</div>
                        <div class="search-meta">
                            <span>${escapeHtml(video.author.name)}</span>
                            ${video.duration ? `<span class="search-duration">${video.duration.timestamp || ''}</span>` : ''}
                        </div>
                    </div>
                    <div class="search-item-actions">
                        <button class="btn-queue-add" data-action="queue" title="เพิ่มในคิว">+ คิว</button>
                    </div>
                `;

                // Click to play immediately
                item.addEventListener('click', (e) => {
                    if (e.target.closest('[data-action="queue"]')) return;
                    if (player) {
                        player.loadVideoById(video.videoId);
                        socket.emit('video-load', video.videoId);
                        showToast(`กำลังเล่น: ${video.title.substring(0, 40)}...`, 'info', 2500);
                    }
                    searchResults.classList.add('hidden');
                    searchInput.value = '';
                });

                // Queue button
                const queueBtn = item.querySelector('[data-action="queue"]');
                queueBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    socket.emit('queue-add', {
                        videoId: video.videoId,
                        title: video.title,
                        thumbnail: video.thumbnail,
                        author: video.author.name
                    });
                    showToast(`เพิ่มในคิว: ${video.title.substring(0, 30)}...`, 'success', 2000);
                });

                searchResults.appendChild(item);
            });
        }
        searchResults.classList.remove('hidden');
    } catch (err) {
        console.error("Search error", err);
        showToast('ค้นหาล้มเหลว กรุณาลองใหม่', 'error');
    }

    searchBtnText.classList.remove('hidden');
    searchSpinner.classList.add('hidden');
    searchBtn.disabled = false;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.innerText = text;
    return div.innerHTML;
}

// ==========================================
// VIDEO SYNC LISTENERS
// ==========================================
socket.on('video-load', (videoId) => {
    if (player && playerReady) {
        isSyncing = true;
        player.loadVideoById(videoId);
        setTimeout(() => isSyncing = false, 800);
    }
});

socket.on('video-play', (time) => {
    if (player && playerReady) {
        const state = player.getPlayerState();
        if (state !== YT.PlayerState.PLAYING) {
            isSyncing = true;
            player.seekTo(time, true);
            player.playVideo();
            setTimeout(() => isSyncing = false, 800);
        }
    }
});

socket.on('video-pause', (time) => {
    if (player && playerReady) {
        const state = player.getPlayerState();
        if (state !== YT.PlayerState.PAUSED) {
            isSyncing = true;
            player.pauseVideo();
            player.seekTo(time, true);
            setTimeout(() => isSyncing = false, 800);
        }
    }
});

socket.on('video-seek', (time) => {
    if (player && playerReady) {
        isSyncing = true;
        player.seekTo(time, true);
        lastKnownTime = time;
        setTimeout(() => isSyncing = false, 800);
    }
});

// Late-joiner state sync
socket.on('sync-state', (state) => {
    if (!player || !playerReady) {
        // Wait and retry
        setTimeout(() => {
            socket.emit('request-sync');
        }, 1000);
        return;
    }

    isSyncing = true;
    if (state.videoId) {
        player.loadVideoById(state.videoId, state.currentTime);
        if (!state.playing) {
            setTimeout(() => {
                player.pauseVideo();
            }, 500);
        }
        showToast('ซิงค์วิดีโอกับห้องเรียบร้อย', 'info', 2000);
    }

    // Sync queue
    if (state.queue && state.queue.length > 0) {
        updateQueueUI(state.queue);
    }

    setTimeout(() => isSyncing = false, 1000);
});

socket.on('force-sync', (expectedTime) => {
    if (player && playerReady) {
        isSyncing = true;
        player.seekTo(expectedTime, true);
        if (player.getPlayerState() !== YT.PlayerState.PLAYING) {
            player.playVideo();
        }
        showToast('ซิงค์เวลาวิดีโอใหม่...', 'info', 1500);
        setTimeout(() => isSyncing = false, 800);
    }
});

// ==========================================
// 2. WEBRTC VIDEO CALL
// ==========================================
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const remotePlaceholder = document.getElementById('remotePlaceholder');

let localStream;
let peerConnection;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        // Free TURN from OpenRelay
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 10
};

async function startMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
            audio: { echoCancellation: true, noiseSuppression: true }
        });
        localVideo.srcObject = localStream;
    } catch (err) {
        console.error("Failed to get local stream", err);
        if (err.name === 'NotAllowedError') {
            showToast('กรุณาอนุญาตการใช้กล้องและไมค์', 'warning');
        } else if (err.name === 'NotFoundError') {
            showToast('ไม่พบกล้องหรือไมค์', 'warning');
        } else {
            showToast('ไม่สามารถเปิดกล้อง/ไมค์ได้', 'error');
        }
    } finally {
        // Join room ONLY after camera is ready or permission is resolved
        // This fixes the bug where the other person doesn't see the camera
        socket.emit('join-room', roomId);
    }
}

function createPeerConnection() {
    if (peerConnection) {
        peerConnection.close();
    }

    peerConnection = new RTCPeerConnection(rtcConfig);

    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }

    peerConnection.ontrack = (event) => {
        remoteVideo.srcObject = event.streams[0];
        remotePlaceholder.classList.add('hidden');
        reconnectAttempts = 0;
        // Also mirror to fullscreen bar video
        const fsVid = document.getElementById('fsRemoteVideo');
        if (fsVid) fsVid.srcObject = event.streams[0];
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', event.candidate);
        }
    };

    peerConnection.oniceconnectionstatechange = () => {
        const state = peerConnection.iceConnectionState;
        console.log('ICE state:', state);

        if (state === 'disconnected' || state === 'failed') {
            if (reconnectAttempts < MAX_RECONNECT) {
                reconnectAttempts++;
                showToast(`กำลังเชื่อมต่อ Video Call ใหม่... (${reconnectAttempts}/${MAX_RECONNECT})`, 'warning', 2000);
                setTimeout(() => attemptReconnect(), 1500);
            } else {
                showToast('ไม่สามารถเชื่อมต่อ Video Call ได้ กรุณา refresh หน้า', 'error', 5000);
            }
        }

        if (state === 'connected') {
            reconnectAttempts = 0;
            showToast('Video Call เชื่อมต่อแล้ว! 🎉', 'success');
        }
    };
}

async function attemptReconnect() {
    createPeerConnection();
    try {
        const offer = await peerConnection.createOffer({ iceRestart: true });
        await peerConnection.setLocalDescription(offer);
        socket.emit('offer', offer);
    } catch (e) {
        console.error('Reconnect failed:', e);
    }
}

// WebRTC Signaling
socket.on('user-connected', async (userId) => {
    showToast('แฟนเข้ามาในห้องแล้ว! กำลังเชื่อมต่อ...', 'info');
    createPeerConnection();

    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('offer', offer);
    } catch (e) {
        console.error('Failed to create offer:', e);
        showToast('ไม่สามารถเริ่ม Video Call ได้', 'error');
    }
});

socket.on('offer', async (data) => {
    if (!peerConnection) createPeerConnection();

    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('answer', answer);
    } catch (e) {
        console.error('Failed to handle offer:', e);
    }
});

socket.on('answer', async (data) => {
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
    } catch (e) {
        console.error('Failed to handle answer:', e);
    }
});

socket.on('ice-candidate', async (candidate) => {
    if (peerConnection) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            console.error('Error adding ICE candidate:', e);
        }
    }
});

socket.on('user-disconnected', () => {
    showToast('แฟนออกจากห้องแล้ว 😢', 'warning');
    remotePlaceholder.classList.remove('hidden');

    if (remoteVideo.srcObject) {
        remoteVideo.srcObject.getTracks().forEach(track => track.stop());
        remoteVideo.srcObject = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
});

// ==========================================
// 3. CALL CONTROLS
// ==========================================
const toggleMicBtn = document.getElementById('toggleMicBtn');
const toggleCamBtn = document.getElementById('toggleCamBtn');
const micOnIcon = document.getElementById('micOnIcon');
const micOffIcon = document.getElementById('micOffIcon');
const camOnIcon = document.getElementById('camOnIcon');
const camOffIcon = document.getElementById('camOffIcon');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const volumeSlider = document.getElementById('volumeSlider');

let micEnabled = true;
let camEnabled = true;

toggleMicBtn.addEventListener('click', () => {
    if (!localStream) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach(track => track.enabled = micEnabled);

    toggleMicBtn.classList.toggle('muted', !micEnabled);
    micOnIcon.classList.toggle('hidden', !micEnabled);
    micOffIcon.classList.toggle('hidden', micEnabled);

    showToast(micEnabled ? 'เปิดไมค์แล้ว' : 'ปิดไมค์แล้ว', 'info', 1500);
});

toggleCamBtn.addEventListener('click', () => {
    if (!localStream) return;
    camEnabled = !camEnabled;
    localStream.getVideoTracks().forEach(track => track.enabled = camEnabled);

    toggleCamBtn.classList.toggle('muted', !camEnabled);
    camOnIcon.classList.toggle('hidden', !camEnabled);
    camOffIcon.classList.toggle('hidden', camEnabled);

    showToast(camEnabled ? 'เปิดกล้องแล้ว' : 'ปิดกล้องแล้ว', 'info', 1500);
});

// Fullscreen with Bottom Bar
const fsBottomBar = document.getElementById('fsBottomBar');
const fsRemoteVideo = document.getElementById('fsRemoteVideo');
const fsMicBtn = document.getElementById('fsMicBtn');
const fsCamBtn = document.getElementById('fsCamBtn');
const fsVolumeSlider = document.getElementById('fsVolumeSlider');
const fsExitBtn = document.getElementById('fsExitBtn');

let fsHideTimer = null;

fullscreenBtn.addEventListener('click', () => {
    const wrapper = document.getElementById('playerWrapper');
    if (!document.fullscreenElement) {
        wrapper.requestFullscreen().catch(err => {
            showToast('ไม่สามารถเปิดเต็มจอได้', 'error');
        });
    } else {
        document.exitFullscreen();
    }
});

// Listen for fullscreen changes
document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
        // Entering fullscreen — mirror remote video stream
        if (remoteVideo.srcObject) {
            fsRemoteVideo.srcObject = remoteVideo.srcObject;
        }
        // Sync volume slider
        fsVolumeSlider.value = volumeSlider.value;
        // Sync mute/cam button states
        fsMicBtn.classList.toggle('muted', !micEnabled);
        fsCamBtn.classList.toggle('muted', !camEnabled);
        // Show bar initially then auto-hide
        showFsBar();
    } else {
        // Exiting fullscreen — cleanup
        fsBottomBar.classList.remove('visible');
        clearTimeout(fsHideTimer);
    }
});

// Mouse move shows bar, auto-hide after 3 seconds
document.getElementById('playerWrapper').addEventListener('mousemove', () => {
    if (document.fullscreenElement) {
        showFsBar();
    }
});

function showFsBar() {
    fsBottomBar.classList.add('visible');
    clearTimeout(fsHideTimer);
    fsHideTimer = setTimeout(() => {
        fsBottomBar.classList.remove('visible');
    }, 3000);
}

// Keep bar visible when hovering on it
fsBottomBar.addEventListener('mouseenter', () => {
    clearTimeout(fsHideTimer);
    fsBottomBar.classList.add('visible');
});

fsBottomBar.addEventListener('mouseleave', () => {
    fsHideTimer = setTimeout(() => {
        fsBottomBar.classList.remove('visible');
    }, 2000);
});

// Fullscreen bar controls — synced with main controls
fsMicBtn.addEventListener('click', () => {
    toggleMicBtn.click(); // trigger main mic toggle
    fsMicBtn.classList.toggle('muted', !micEnabled);
});

fsCamBtn.addEventListener('click', () => {
    toggleCamBtn.click(); // trigger main cam toggle
    fsCamBtn.classList.toggle('muted', !camEnabled);
});

fsVolumeSlider.addEventListener('input', (e) => {
    const vol = parseInt(e.target.value);
    if (player && playerReady) player.setVolume(vol);
    volumeSlider.value = vol; // sync main slider
});

fsExitBtn.addEventListener('click', () => {
    document.exitFullscreen();
});

// Keep fsRemoteVideo in sync when remote stream changes
const origOnTrack = remoteVideo.onloadedmetadata;
const remoteVideoObserver = new MutationObserver(() => {
    if (document.fullscreenElement && remoteVideo.srcObject) {
        fsRemoteVideo.srcObject = remoteVideo.srcObject;
    }
});

// Volume Control
volumeSlider.addEventListener('input', (e) => {
    if (player && playerReady) {
        player.setVolume(parseInt(e.target.value));
    }
});

// ==========================================
// 4. CHAT SYSTEM
// ==========================================
const chatInput = document.getElementById('chatInput');
const sendChatBtn = document.getElementById('sendChatBtn');
const chatMessages = document.getElementById('chatMessages');

const myName = 'คุณ';
let chatStarted = false;

sendChatBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChat();
});

function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;

    socket.emit('chat-message', {
        text: text,
        sender: myName
    });

    chatInput.value = '';
    chatInput.focus();
}

socket.on('chat-message', (msg) => {
    if (!chatStarted) {
        chatMessages.innerHTML = '';
        chatStarted = true;
    }

    const isSelf = msg.senderId === socket.id;
    const msgEl = document.createElement('div');
    msgEl.className = `chat-msg ${isSelf ? 'self' : 'other'}`;

    const time = new Date(msg.timestamp);
    const timeStr = time.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

    msgEl.innerHTML = `
        ${escapeHtml(msg.text)}
        <span class="msg-time">${timeStr}</span>
    `;

    chatMessages.appendChild(msgEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
});

// System messages for connection events
socket.on('user-connected', () => {
    addSystemMessage('💕 แฟนเข้ามาในห้องแล้ว!');
});

socket.on('user-disconnected', () => {
    addSystemMessage('😢 แฟนออกจากห้องแล้ว');
});

function addSystemMessage(text) {
    if (!chatStarted) {
        chatMessages.innerHTML = '';
        chatStarted = true;
    }
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-msg system';
    msgEl.innerText = text;
    chatMessages.appendChild(msgEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ==========================================
// 5. VIDEO QUEUE
// ==========================================
const queueList = document.getElementById('queueList');
const queueCount = document.getElementById('queueCount');
const toggleQueueBtn = document.getElementById('toggleQueueBtn');
const queueHeader = document.querySelector('.queue-header');

queueHeader.addEventListener('click', () => {
    queueList.classList.toggle('hidden');
    toggleQueueBtn.style.transform = queueList.classList.contains('hidden') ? '' : 'rotate(180deg)';
});

socket.on('queue-update', (queue) => {
    updateQueueUI(queue);
});

function updateQueueUI(queue) {
    queueCount.innerText = queue.length;
    queueList.innerHTML = '';

    if (queue.length === 0) {
        queueList.innerHTML = '<div style="padding:8px 16px;color:var(--text-muted);font-size:0.75rem;">คิวว่าง</div>';
        return;
    }

    queue.forEach((video, index) => {
        const item = document.createElement('div');
        item.className = 'queue-item';
        item.innerHTML = `
            <img class="queue-item-thumb" src="${video.thumbnail}" alt="" loading="lazy">
            <span class="queue-item-title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</span>
            <button class="queue-item-remove" data-index="${index}" title="ลบออกจากคิว">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        `;

        // Click to play
        item.addEventListener('click', (e) => {
            if (e.target.closest('.queue-item-remove')) return;
            socket.emit('queue-play', index);
        });

        // Remove from queue
        item.querySelector('.queue-item-remove').addEventListener('click', (e) => {
            e.stopPropagation();
            socket.emit('queue-remove', index);
        });

        queueList.appendChild(item);
    });
    });
}

// ==========================================
// 6. REACTIONS
// ==========================================
document.querySelectorAll('.btn-reaction').forEach(btn => {
    btn.addEventListener('click', () => {
        const emoji = btn.getAttribute('data-emoji');
        socket.emit('reaction', emoji);
    });
});

socket.on('reaction', (data) => {
    const wrapper = document.getElementById('playerWrapper');
    const emojiEl = document.createElement('div');
    emojiEl.className = 'floating-emoji';
    emojiEl.innerText = data.emoji;
    
    const randomOffset = Math.random() * 40 - 20;
    emojiEl.style.marginRight = `${randomOffset}px`;
    
    wrapper.appendChild(emojiEl);
    
    setTimeout(() => {
        emojiEl.remove();
    }, 2000);
});

// ==========================================
// 7. TYPING INDICATOR
// ==========================================
const typingIndicator = document.getElementById('typingIndicator');
let typingTimeout = null;
let isTyping = false;

chatInput.addEventListener('input', () => {
    if (!isTyping) {
        isTyping = true;
        socket.emit('typing', myName);
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        isTyping = false;
        socket.emit('stop-typing');
    }, 1500);
});

socket.on('typing', (name) => {
    if (typingIndicator) typingIndicator.classList.remove('hidden');
});

socket.on('stop-typing', () => {
    if (typingIndicator) typingIndicator.classList.add('hidden');
});

// ==========================================
// 8. THEATER MODE
// ==========================================
const theaterModeBtn = document.getElementById('theaterModeBtn');
const theaterOnIcon = document.getElementById('theaterOnIcon');
const theaterOffIcon = document.getElementById('theaterOffIcon');
let isTheaterMode = false;

if (theaterModeBtn) {
    theaterModeBtn.addEventListener('click', () => {
        isTheaterMode = !isTheaterMode;
        document.body.classList.toggle('theater-mode', isTheaterMode);
        
        theaterModeBtn.classList.toggle('active', isTheaterMode);
        theaterOnIcon.classList.toggle('hidden', !isTheaterMode);
        theaterOffIcon.classList.toggle('hidden', isTheaterMode);
        
        showToast(isTheaterMode ? 'เปิดโหมดโรงหนังแล้ว 🎬' : 'ปิดโหมดโรงหนังแล้ว', 'info', 1500);
    });
}

// ==========================================
// INITIALIZE
// ==========================================
startMedia();
