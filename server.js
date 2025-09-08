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

  // Обработчик disconnect - УДАЛЯЕМ ПОЛЬЗОВАТЕЛЯ ПРИ РАЗРЫВЕ СОЕДИНЕНИЯ
  socket.on('disconnect', (reason) => {
    console.log('❌ User disconnected:', socket.id, 'Reason:', reason);
    
    // Удаляем пользователя из всех комнат, где он был
    if (socket.roomName && roomConnections.has(socket.roomName) && socket.user_id) {
      // Удаляем пользователя по user_id
      if (roomConnections.get(socket.roomName).has(socket.user_id)) {
        const userInfo = roomConnections.get(socket.roomName).get(socket.user_id);
        roomConnections.get(socket.roomName).delete(socket.user_id);
        
        const onlineCount = roomConnections.get(socket.roomName).size;
        const users = Array.from(roomConnections.get(socket.roomName).values());
        
        // Отправляем обновление ВСЕМ оставшимся в комнате
        io.to(socket.roomName).emit('online_users_update', { 
          count: onlineCount,
          room: socket.roomName,
          project_id: socket.project_id,
          users: users
        });
        
        console.log(`👤 User ${userInfo.username} disconnected from room ${socket.roomName}, now ${onlineCount} users`);
        
        if (roomConnections.get(socket.roomName).size === 0) {
          roomConnections.delete(socket.roomName);
          console.log(`🗑️ Room ${socket.roomName} deleted (empty)`);
        }
      }
    }
  });

  // Обработчик leave_project_chat
  socket.on('leave_project_chat', (roomData) => {
    try {
      const { project_id, user_id } = roomData;
      const roomName = `project_${project_id}`;
      
      console.log(`👤 User requested to leave room: ${roomName}`);
      
      if (roomConnections.has(roomName) && user_id) {
        if (roomConnections.get(roomName).has(user_id)) {
          const userInfo = roomConnections.get(roomName).get(user_id);
          roomConnections.get(roomName).delete(user_id);
          
          const onlineCount = roomConnections.get(roomName).size;
          const users = Array.from(roomConnections.get(roomName).values());
          
          io.to(roomName).emit('online_users_update', { 
            count: onlineCount,
            room: roomName,
            project_id: project_id,
            users: users
          });
          
          console.log(`👤 User ${userInfo.username} left room ${roomName}, now ${onlineCount} users`);
          
          if (onlineCount === 0) {
            roomConnections.delete(roomName);
            console.log(`🗑️ Room ${roomName} deleted (empty)`);
          }
        }
        
        socket.leave(roomName);
        console.log(`🚪 Socket left room: ${roomName}`);
      }
    } catch (error) {
      console.error('❌ Error leaving room:', error);
    }
  });

  // Обработчик rejoin_project_chat
  socket.on('rejoin_project_chat', async (roomData) => {
    try {
      const { project_id, user_id, username } = roomData;
      const roomName = `project_${project_id}`;
      
      console.log(`🔁 User rejoining room: ${roomName}`);
      
      // Принудительно добавляем пользователя в комнату
      if (!roomConnections.has(roomName)) {
        roomConnections.set(roomName, new Map());
      }
      
      // Обновляем информацию о пользователе
      roomConnections.get(roomName).set(user_id, { 
        user_id, 
        username,
        socket_id: socket.id,
        joined_at: new Date().toISOString()
      });
      
      // Присоединяем сокет к комнате
      socket.join(roomName);
      socket.roomName = roomName;
      socket.project_id = project_id;
      socket.user_id = user_id;
      
      const onlineCount = roomConnections.get(roomName).size;
      const users = Array.from(roomConnections.get(roomName).values());
      
      // Отправляем обновление ВСЕМ в комнате
      io.to(roomName).emit('online_users_update', { 
        count: onlineCount,
        room: roomName,
        project_id: project_id,
        users: users
      });
      
      // Отправляем историю сообщений возвращающемуся пользователю
      try {
        const response = await axios.get(`${DJANGO_URL}/api/get-messages/${project_id}/`);
        socket.emit('message_history', response.data);
      } catch (error) {
        console.error('❌ Error fetching message history for rejoin:', error.message);
      }
      
      console.log(`👤 User ${username} rejoined room ${roomName}, now ${onlineCount} users`);
    } catch (error) {
      console.error('❌ Error rejoining room:', error);
    }
  });

  // Обработчик запроса обновления комнаты
  socket.on('request_room_update', (roomData) => {
    try {
      const { project_id } = roomData;
      const roomName = `project_${project_id}`;
      
      if (roomConnections.has(roomName)) {
        const onlineCount = roomConnections.get(roomName).size;
        const users = Array.from(roomConnections.get(roomName).values());
        
        // Отправляем обновление запросившему пользователю
        socket.emit('request_room_update_response', {
          count: onlineCount,
          room: roomName,
          project_id: project_id,
          users: users
        });
        
        console.log(`📋 Room update sent for ${roomName}: ${onlineCount} users`);
      } else {
        // Если комнаты нет, отправляем пустой ответ
        socket.emit('request_room_update_response', {
          count: 0,
          room: roomName,
          project_id: project_id,
          users: []
        });
      }
    } catch (error) {
      console.error('❌ Error sending room update:', error);
    }
  });

  // Обработчик запроса истории сообщений
  socket.on('get_message_history', async (roomData) => {
    try {
      const { project_id } = roomData;
      
      try {
        const response = await axios.get(`${DJANGO_URL}/api/get-messages/${project_id}/`);
        socket.emit('message_history', response.data);
        console.log(`📚 Message history sent for project ${project_id}`);
      } catch (error) {
        console.error('❌ Error fetching message history:', error.message);
      }
    } catch (error) {
      console.error('❌ Error in get_message_history:', error);
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
      
      // Проверяем, есть ли уже пользователь в комнате
      if (roomConnections.get(roomName).has(user_id)) {
        console.log(`🔄 User ${username} already in room, updating connection`);
      }
      
      // Храним по user_id вместо socket.id
      roomConnections.get(roomName).set(user_id, { 
        user_id, 
        username,
        socket_id: socket.id,
        joined_at: new Date().toISOString()
      });
      
      console.log(`👥 ${username} joined project chat ${project_id}`);
      
      const onlineCount = roomConnections.get(roomName).size;
      const users = Array.from(roomConnections.get(roomName).values());
      
      io.to(roomName).emit('online_users_update', { 
        count: onlineCount,
        room: roomName,
        project_id: project_id,
        users: users
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

}); // Конец io.on('connection')

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

// Endpoint для получения информации о комнате
app.get('/room-info/:project_id', (req, res) => {
  const project_id = req.params.project_id;
  const roomName = `project_${project_id}`;
  
  const roomInfo = roomConnections.has(roomName) ? {
    exists: true,
    user_count: roomConnections.get(roomName).size,
    users: Array.from(roomConnections.get(roomName).values())
  } : {
    exists: false,
    user_count: 0,
    users: []
  };
  
  res.json(roomInfo);
});

// Endpoint для отладки комнаты
app.get('/debug-room/:project_id', (req, res) => {
  const project_id = req.params.project_id;
  const roomName = `project_${project_id}`;
  
  if (roomConnections.has(roomName)) {
    const roomData = roomConnections.get(roomName);
    res.json({
      room: roomName,
      user_count: roomData.size,
      users: Array.from(roomData.entries())
    });
  } else {
    res.json({
      room: roomName,
      user_count: 0,
      users: [],
      status: 'room_not_found'
    });
  }
});

// Endpoint для сброса комнат
app.get('/reset-rooms', (req, res) => {
  const previousCount = roomConnections.size;
  roomConnections.clear();
  
  console.log(`🗑️ Cleared all rooms (${previousCount} rooms removed)`);
  
  res.json({
    status: 'success',
    message: `Cleared ${previousCount} rooms`,
    rooms_cleared: previousCount
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
  console.log(`📍 Debug room: http://0.0.0.0:${PORT}/debug-room/53`);
  console.log(`📍 Test Django connection: http://0.0.0.0:${PORT}/test-django`);
  console.log(`📡 Socket.IO ready for connections`);
});
