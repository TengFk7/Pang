const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const path = require('path');
const ytSearch = require('yt-search');

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// Room State Storage
// ==========================================
const roomStates = {}; // { roomId: { videoId, playing, currentTime, lastUpdate, queue[] } }

function getRoomState(roomId) {
    if (!roomStates[roomId]) {
        roomStates[roomId] = {
            videoId: null,
            playing: false,
            currentTime: 0,
            lastUpdate: Date.now(),
            queue: []
        };
    }
    return roomStates[roomId];
}

function getRoomUserCount(roomId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    return room ? room.size : 0;
}

// ==========================================
// YouTube Search API
// ==========================================
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.json([]);
        const results = await ytSearch(query);
        const videos = results.videos.slice(0, 10);
        res.json(videos);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Search failed" });
    }
});

// Simple routing to handle dynamic rooms
app.get('/room/:room', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Redirect root to a default room
app.get('/', (req, res) => {
    const defaultRoomId = Math.random().toString(36).substring(2, 8);
    res.redirect(`/room/${defaultRoomId}`);
});

// ==========================================
// Socket.io
// ==========================================
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        socket.roomId = roomId;
        console.log(`Socket ${socket.id} joined room ${roomId}`);

        const userCount = getRoomUserCount(roomId);

        // Notify all users in room about user count update
        io.to(roomId).emit('user-count', userCount);

        // Notify other users in the room
        socket.to(roomId).emit('user-connected', socket.id);

        // =====================
        // Late-Joiner State Sync
        // =====================
        socket.on('request-sync', () => {
            const state = getRoomState(roomId);
            if (state.videoId) {
                // Estimate current time if video was playing
                let estimatedTime = state.currentTime;
                if (state.playing) {
                    const elapsed = (Date.now() - state.lastUpdate) / 1000;
                    estimatedTime += elapsed;
                }
                socket.emit('sync-state', {
                    videoId: state.videoId,
                    playing: state.playing,
                    currentTime: estimatedTime,
                    queue: state.queue
                });
            }
        });

        // =====================
        // Disconnect
        // =====================
        socket.on('disconnect', () => {
            console.log(`Socket ${socket.id} left room ${roomId}`);
            socket.to(roomId).emit('user-disconnected', socket.id);

            const userCount = getRoomUserCount(roomId);
            io.to(roomId).emit('user-count', userCount);

            // Cleanup empty rooms after delay
            setTimeout(() => {
                if (getRoomUserCount(roomId) === 0) {
                    delete roomStates[roomId];
                    console.log(`Room ${roomId} cleaned up`);
                }
            }, 60000);
        });

        // =====================
        // WebRTC Signaling
        // =====================
        socket.on('offer', (data) => {
            socket.to(roomId).emit('offer', { ...data, from: socket.id });
        });

        socket.on('answer', (data) => {
            socket.to(roomId).emit('answer', { ...data, from: socket.id });
        });

        socket.on('ice-candidate', (data) => {
            socket.to(roomId).emit('ice-candidate', data);
        });

        // =====================
        // Video Synchronization
        // =====================
        socket.on('video-load', (videoId) => {
            const state = getRoomState(roomId);
            state.videoId = videoId;
            state.currentTime = 0;
            state.playing = true;
            state.lastUpdate = Date.now();
            socket.to(roomId).emit('video-load', videoId);
        });

        socket.on('video-play', (time) => {
            const state = getRoomState(roomId);
            state.playing = true;
            state.currentTime = time;
            state.lastUpdate = Date.now();
            socket.to(roomId).emit('video-play', time);
        });

        socket.on('video-pause', (time) => {
            const state = getRoomState(roomId);
            state.playing = false;
            state.currentTime = time;
            state.lastUpdate = Date.now();
            socket.to(roomId).emit('video-pause', time);
        });

        socket.on('video-seek', (time) => {
            const state = getRoomState(roomId);
            state.currentTime = time;
            state.lastUpdate = Date.now();
            socket.to(roomId).emit('video-seek', time);
        });

        // =====================
        // Chat
        // =====================
        socket.on('chat-message', (msg) => {
            io.to(roomId).emit('chat-message', {
                text: msg.text,
                sender: msg.sender,
                senderId: socket.id,
                timestamp: Date.now()
            });
        });

        // =====================
        // Video Queue
        // =====================
        socket.on('queue-add', (video) => {
            const state = getRoomState(roomId);
            state.queue.push(video);
            io.to(roomId).emit('queue-update', state.queue);
        });

        socket.on('queue-remove', (index) => {
            const state = getRoomState(roomId);
            state.queue.splice(index, 1);
            io.to(roomId).emit('queue-update', state.queue);
        });

        socket.on('queue-play', (index) => {
            const state = getRoomState(roomId);
            if (state.queue[index]) {
                const video = state.queue.splice(index, 1)[0];
                state.videoId = video.videoId;
                state.currentTime = 0;
                state.playing = true;
                state.lastUpdate = Date.now();
                io.to(roomId).emit('video-load', video.videoId);
                io.to(roomId).emit('queue-update', state.queue);
            }
        });
    });
});

server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
