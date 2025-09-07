// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// ЕДИНСТВЕННОЕ ИЗМЕНЕНИЕ: Динамический URL для Django
const DJANGO_URL = process.env.NODE_ENV === 'production' 
  ? 'https://silexp.ru' 
  : 'http://localhost:8000';

console.log('Django URL:', DJANGO_URL);

// Инициализация Socket.IO
const io = new Server(server, {
  cors: {
    origin: DJANGO_URL,  // Django сервер
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Хранилище для онлайн пользователей
const roomConnections = new Map();

// Тестирование подключения к Django
console.log('🔍 Testing Django connection...');

axios.get(`${DJANGO_URL}/api/test`)
  .then(response => {
    console.log('✅ Django connection successful:', response.data);
  })
  .catch(error => {
    console.error('❌ Django connection failed:', error.message);
  });

// Обработка Socket.IO подключений
io.on('connection', (socket) => {
    console.log('✅ User connected:', socket.id);

    // Обработка отключения и повторного подключения
    socket.on('disconnect', (reason) => {
        console.log('❌ User disconnected:', socket.id, 'Reason:', reason);
        
        // Выходим из всех комнат при отключении
        if (socket.roomName && roomConnections.has(socket.roomName)) {
            roomConnections.get(socket.roomName).delete(socket.id);
            
            const onlineCount = roomConnections.get(socket.roomName).size;
            io.to(socket.roomName).emit('online_users_update', { count: onlineCount });
        }
    });
	

  // Присоединение к комнате проекта
  socket.on('join_project_chat', async (roomData) => {
    try {
      const { project_id, user_id, username } = roomData;
      const roomName = `project_${project_id}`;
      
      socket.join(roomName);
      socket.roomName = roomName;
      socket.project_id = project_id;
      socket.user_id = user_id;
      
      // Добавляем в хранилище
      if (!roomConnections.has(roomName)) {
        roomConnections.set(roomName, new Map());
      }
      roomConnections.get(roomName).set(socket.id, { user_id, username });
      
      console.log(`👥 ${username} joined project chat ${project_id}`);
      
      // Отправляем обновление онлайн статуса
      const onlineCount = roomConnections.get(roomName).size;
      io.to(roomName).emit('online_users_update', { count: onlineCount });
      
      // Отправляем историю сообщений при подключении
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

  // ОТПРАВКА СООБЩЕНИЯ
  socket.on('send_message', async (messageData) => {
    try {
      const { project_id, body, user_id, username, first_name } = messageData;
      const roomName = `project_${project_id}`;
      
      console.log(`📨 Received message for saving:`, { project_id, body, user_id });
      
      // Сохраняем через Django API
      const response = await axios.post(`${DJANGO_URL}/api/save-message/', {
        project_id: project_id,
        body: body,
        author_id: user_id
      }, {
        timeout: 5000
      });

      console.log('✅ Message saved in Django database:', response.data);
      
      if (response.data.status === 'success') {
        // Отправляем сообщение в комнату
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Node.js server is running!',
    timestamp: new Date().toISOString(),
	django_url: DJANGO_URL,
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

// Тестовый endpoint для проверки связи с Django
app.get('/test-django', async (req, res) => {
  try {
    console.log('Testing connection to Django...');
    const response = await axios.get(`${DJANGO_URL}/api/test/', {
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

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`📍 Django URL: ${DJANGO_URL}`);
  console.log(`📡 Socket.IO ready for connections`);
});


