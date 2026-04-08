const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.options('*', cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Логирование запросов
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Статические файлы: веб-приложение (для браузера)
app.use(express.static(path.join(__dirname, 'public')));

// Статические файлы для MSX (start.json, content.json, иконки)
app.use('/msx', express.static(path.join(__dirname, 'msx')));

// API роуты (парсинг hdkinoteatr.com)
const apiRouter = require('./routes/api');
app.use('/api', apiRouter);

// Корневой маршрут – отдаём веб-приложение (public/index.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Проверка статуса
app.get('/status', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Обработка 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Глобальный обработчик ошибок
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  console.log(`👉 Стартовый параметр MSX: https://hdkinoteatr-msx.onrender.com/msx/start.json`);
  console.log(`👉 Веб-приложение: https://hdkinoteatr-msx.onrender.com/`);
});
