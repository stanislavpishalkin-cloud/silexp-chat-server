// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
const server = http.createServer(app);

// Инициализация Socket.IO
const io = new Server(server, {
  cors: {
    origin: [
      "https://silexp.ru",
      "https://silexp-chat-server.onrender.com",
      "http://localhost:8000",
      "http://localhost:3000"
    ],
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

const DJANGO_URL = "https://silexp.ru";
const roomConnections = new Map();

// Тестирование подключения к Django
console.log('🔍 Testing Django connection...');

axios.get(`${DJANGO_URL}/api/test/`)
  .then(response => {
    console.log('✅ Django connection successful:', response.data);
  })
  .catch(error => {
    console.error('❌ Django connection failed:', error.message);
  });

// Обработка Socket.IO подключений
io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);
  
  socket.on('ping', (cb) => {
    if (typeof cb === 'function') cb();
  });

  // Обработчик disconnect
  socket.on('disconnect', (reason) => {
    console.log('❌ User disconnected:', socket.id, 'Reason:', reason);
    
    if (socket.roomName && roomConnections.has(socket.roomName)) {
      roomConnections.get(socket.roomName).delete(socket.id);
      
      const onlineCount = roomConnections.get(socket.roomName).size;
      io.to(socket.roomName).emit('online_users_update', { 
        count: onlineCount,
        room: socket.roomName,
        project_id: socket.project_id
      });
      
      console.log(`👤 User left room ${socket.roomName}, now ${onlineCount} users`);
      
      if (roomConnections.get(socket.roomName).size === 0) {
        roomConnections.delete(socket.roomName);
        console.log(`🗑️ Room ${socket.roomName} deleted (empty)`);
      }
    }
  });

  // Обработчик leave_project_chat
  socket.on('leave_project_chat', (roomData) => {
    try {
      const { project_id } = roomData;
      const roomName = `project_${project_id}`;
      
      console.log(`👤 User requested to leave room: ${roomName}`);
      
      if (roomConnections.has(roomName)) {
        roomConnections.get(roomName).delete(socket.id);
        
        const onlineCount = roomConnections.get(roomName).size;
        io.to(roomName).emit('online_users_update', { 
          count: onlineCount,
          room: roomName,
          project_id: project_id
        });
        
        console.log(`👤 User left room ${roomName}, now ${onlineCount} users`);
        
        if (onlineCount === 0) {
          roomConnections.delete(roomName);
          console.log(`🗑️ Room ${roomName} deleted (empty)`);
        }
        
        socket.leave(roomName);
        console.log(`🚪 Socket left room: ${roomName}`);
      }
    } catch (error) {
      console.error('❌ Error leaving room:', error);
    }
  });

  // Обработчик join_project_chat
  socket.on('join_project_chat', async (roomData) => {
    try {
      const { project_id, user_id, username } = roomData;
      const roomName = `project_${project_id}`;
      
      socket.join(roomName);
      socket.roomName = roomName;
      socket.project_id = project_id;
      socket.user_id = user_id;
      
      if (!roomConnections.has(roomName)) {
        roomConnections.set(roomName, new Map());
      }
      roomConnections.get(roomName).set(socket.id, { user_id, username });
      
      console.log(`👥 ${username} joined project chat ${project_id}`);
      
      const onlineCount = roomConnections.get(roomName).size;
      io.to(roomName).emit('online_users_update', { 
        count: onlineCount,
        room: roomName,
        project_id: project_id
      });
      
      try {
        const response = await axios.get(`${DJANGO_URL}/api/get-messages/${project_id}/`);
        socket.emit('message_history', response.data);
      } catch (error) {
        console.error('❌ Error fetching message history:', error.message);
      }
      
    } catch (error) {
      console.error('❌ Error joining room:', error);
    }
  });

  // Обработчик send_message
  socket.on('send_message', async (messageData) => {
    try {
      const { project_id, body, user_id, username, first_name } = messageData;
      const roomName = `project_${project_id}`;
      
      console.log(`📨 Received message for saving:`, { project_id, body, user_id });
      
      const response = await axios.post(`${DJANGO_URL}/api/save-message/`, {
        project_id: project_id,
        body: body,
        author_id: user_id
      }, {
        timeout: 5000
      });

      console.log('✅ Message saved in Django database:', response.data);
      
      if (response.data.status === 'success') {
        io.to(roomName).emit('receive_message', {
          id: response.data.message_id,
          body: body,
          author: user_id,
          author_name: first_name || username,
          author_username: username,
          created: response.data.created,
          project_id: project_id
        });

        console.log('✅ Message sent to all clients in room:', roomName);
      } else {
        throw new Error(response.data.message || 'Unknown error from Django');
      }
      
    } catch (error) {
      console.error('❌ Error saving message to Django:', {
        message: error.message,
        response: error.response?.data,
        code: error.code
      });
      
      socket.emit('error', { 
        message: 'Failed to send message',
        details: error.response?.data || error.message
      });
    }
  });

}); // ← ВАЖНО: Закрывающая скобка для io.on('connection')

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Node.js server is running!',
    timestamp: new Date().toISOString(),
    active_rooms: Array.from(roomConnections.keys())
  });
});

// Статистика
app.get('/stats', (req, res) => {
  const stats = {};
  roomConnections.forEach((users, roomName) => {
    stats[roomName] = users.size;
  });
  
  res.json({
    active_connections: io.engine.clientsCount,
    rooms: stats
  });
});

// Тестовый endpoint
app.get('/test-django', async (req, res) => {
  try {
    console.log('Testing connection to Django...');
    const response = await axios.get(`${DJANGO_URL}/api/test/`, {
      timeout: 5000
    });
    
    console.log('✅ Django response:', response.data);
    res.json({
      status: 'success',
      django_response: response.data
    });
    
  } catch (error) {
    console.error('❌ Error connecting to Django:', {
      message: error.message,
      code: error.code,
      response: error.response?.data
    });
    
    res.json({
      status: 'error',
      error: error.message,
      code: error.code,
      details: error.response?.data || 'No response from Django'
    });
  }
});

// Обработчики ошибок
io.engine.on("connection_error", (err) => {
  console.log('🚨 Socket.IO connection error:', err.req);
  console.log('🚨 Socket.IO error code:', err.code);
  console.log('🚨 Socket.IO error message:', err.message);
  console.log('🚨 Socket.IO error context:', err.context);
});

server.on('upgradeError', (error) => {
  console.error('🚨 Upgrade error:', error);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`📍 Stats: http://0.0.0.0:${PORT}/stats`);
  console.log(`📍 Test Django connection: http://0.0.0.0:${PORT}/test-django`);
  console.log(`📡 Socket.IO ready for connections`);
});
