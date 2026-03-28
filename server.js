const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    path: '/mistd/socket.io/',
    cors: { origin: "*" },
    transports: ['polling', 'websocket']
});

let availableHumidifiers = [];

// Random pairing queues: separate queues for each preference
const randomQueues = {
    unit:  [], // wants to be humidifier
    owner: [], // wants to be owner
    any:   []  // don't care
};

const models = ["VaporMaster 3000", "The Damp Box", "Mist-Lord XL", "Drip-Bot", "Cloud-Maker 500", "AquaBreeze Pro", "HumidKing 9000", "The Wet One"];

function randomModel() {
    return models[Math.floor(Math.random() * models.length)];
}

// Pair two sockets: ownerSocket buys unitSocket
function doPair(ownerSocket, unitSocket) {
    const model = randomModel();
    const roomName = `room_${ownerSocket.id}_${unitSocket.id}`;

    ownerSocket.join(roomName);
    unitSocket.join(roomName);

    unitSocket.emit('random_role_assigned', { role: 'unit', model });
    ownerSocket.emit('random_role_assigned', { role: 'owner' });

    io.to(roomName).emit('paired', { room: roomName, model });
}

// Try to match a new joiner against existing queues
function tryMatchRandom(socket, preference) {
    // Don't add duplicates
    for (const q of Object.values(randomQueues)) {
        if (q.find(s => s.id === socket.id)) return;
    }

    if (preference === 'unit') {
        // I want to be unit — look for someone who wants to be owner or any
        const partner = randomQueues.owner.shift() || randomQueues.any.shift();
        if (partner) {
            doPair(partner, socket); // partner=owner, socket=unit
        } else {
            randomQueues.unit.push(socket);
        }
    } else if (preference === 'owner') {
        // I want to be owner — look for someone who wants to be unit or any
        const partner = randomQueues.unit.shift() || randomQueues.any.shift();
        if (partner) {
            doPair(socket, partner); // socket=owner, partner=unit
        } else {
            randomQueues.owner.push(socket);
        }
    } else {
        // any — look for anyone waiting in any queue, assign opposite roles
        const unitPartner  = randomQueues.unit.shift();
        const ownerPartner = randomQueues.owner.shift();
        const anyPartner   = randomQueues.any.shift();

        if (unitPartner) {
            // They want to be unit, so I become owner
            doPair(socket, unitPartner);
        } else if (ownerPartner) {
            // They want to be owner, so I become unit
            doPair(ownerPartner, socket);
        } else if (anyPartner) {
            // Neither cares — flip a coin
            if (Math.random() < 0.5) doPair(socket, anyPartner);
            else doPair(anyPartner, socket);
        } else {
            randomQueues.any.push(socket);
        }
    }
}

function removeFromQueues(socketId) {
    for (const key of Object.keys(randomQueues)) {
        randomQueues[key] = randomQueues[key].filter(s => s.id !== socketId);
    }
}

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

io.on('connection', (socket) => {
    console.log('Connected:', socket.id);
    socket.emit('update_market', availableHumidifiers);

    // Register as humidifier in the normal market
    socket.on('register_humidifier', (model) => {
        availableHumidifiers.push({ id: socket.id, model });
        io.emit('update_market', availableHumidifiers);
    });

    // Request current market list
    socket.on('request_market', () => {
        socket.emit('update_market', availableHumidifiers);
    });

    // Owner leaves the market view without buying
    socket.on('leave_market', () => {
        // nothing to clean up server-side for owners browsing
    });

    // Owner buys a specific humidifier
    socket.on('buy_unit', (targetId) => {
        const unit = availableHumidifiers.find(u => u.id === targetId);
        if (!unit) return;
        availableHumidifiers = availableHumidifiers.filter(u => u.id !== targetId);
        io.emit('update_market', availableHumidifiers);
        const roomName = `room_${socket.id}_${targetId}`;
        socket.join(roomName);
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) {
            targetSocket.join(roomName);
            io.to(roomName).emit('paired', { room: roomName, model: unit.model });
        }
    });

    // Random pairing with preference
    socket.on('join_random', ({ preference }) => {
        tryMatchRandom(socket, preference || 'any');
    });

    // Chat message relay
    socket.on('send_msg', (data) => {
        io.to(data.room).emit('receive_msg', { senderId: socket.id, text: data.text });
    });

    // Someone clicked Unplug / Shut Off — boot both people in the room
    socket.on('leave_room', ({ room, role }) => {
        const wasOwner = role === 'owner';
        // Notify the OTHER person in the room
        socket.to(room).emit('partner_left', { wasOwner });
        // Leave the room ourselves (caller reloads their own page)
        socket.leave(room);
    });

    // Cleanup on hard disconnect (tab close, etc.)
    socket.on('disconnect', () => {
        availableHumidifiers = availableHumidifiers.filter(u => u.id !== socket.id);
        removeFromQueues(socket.id);
        io.emit('update_market', availableHumidifiers);
        console.log('Disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
