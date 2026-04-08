const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

const BASE_URL = 'https://www.hdkinoteatr.com';
const CATALOG_URL = process.env.CATALOG_URL || `${BASE_URL}/catalog/`;
const SEARCH_URL_TEMPLATE = process.env.SEARCH_URL_TEMPLATE || `${BASE_URL}/index.php?do=search&subaction=search&q={query}`;

// Загрузка HTML с нужными заголовками
async function fetchHTML(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 15000
    });
    return response.data;
  } catch (error) {
    console.error(`Ошибка загрузки ${url}:`, error.message);
    return null;
  }
}

// Парсер списка фильмов (карточки из /catalog/)
function parseMoviesList(html) {
  const $ = cheerio.load(html);
  const movies = [];

  // Селекторы для карточек (подберите под актуальную вёрстку)
  $('.movie-item, .film-item, .item, .short-item, .news-item').each((i, el) => {
    const $card = $(el);
    const $a = $card.find('a').first();
    let link = $a.attr('href');
    if (!link) return;

    // Преобразуем относительную ссылку в абсолютную
    if (link && !link.startsWith('http')) {
      link = BASE_URL + (link.startsWith('/') ? link : '/' + link);
    }
    // Отбрасываем ссылки на картинки и другие не-страницы
    if (link.includes('/uploads/') || link.match(/\.(jpg|png|gif|jpeg|webp)$/i)) return;

    let title = $a.attr('title') || $a.find('.title, h3, .name').first().text().trim();
    if (!title) title = $card.find('.title, h3, .name').first().text().trim();
    if (!title) return;

    let poster = $card.find('img').first().attr('src');
    if (poster && !poster.startsWith('http')) poster = BASE_URL + (poster.startsWith('/') ? poster : '/' + poster);

    let year = $card.find('.year, .date, .info-year').first().text().trim() || '—';
    let rating = $card.find('.rating, .imdb, .rate').first().text().trim() || '—';

    movies.push({
      id: Buffer.from(link, 'utf8').toString('base64'),
      title,
      poster: poster || '/placeholder.jpg',
      year,
      rating,
      link
    });
  });

  // Если не нашли карточки – универсальный поиск (любые a с img)
  if (movies.length === 0) {
    $('a').each((i, el) => {
      const $a = $(el);
      const $img = $a.find('img');
      if ($img.length === 0) return;
      let link = $a.attr('href');
      if (!link || link.includes('/uploads/') || link.match(/\.(jpg|png|gif|jpeg)$/i)) return;
      if (link && !link.startsWith('http')) link = BASE_URL + (link.startsWith('/') ? link : '/' + link);
      let title = $a.attr('title') || $img.attr('alt') || $a.find('h3, .title, .name').first().text().trim();
      if (!title) return;
      let poster = $img.attr('src');
      if (poster && !poster.startsWith('http')) poster = BASE_URL + (poster.startsWith('/') ? poster : '/' + poster);
      movies.push({
        id: Buffer.from(link, 'utf8').toString('base64'),
        title,
        poster: poster || '/placeholder.jpg',
        year: '—',
        rating: '—',
        link
      });
    });
  }

  // Удаляем дубликаты
  const unique = [];
  const seen = new Set();
  for (const m of movies) {
    if (!seen.has(m.link)) {
      seen.add(m.link);
      unique.push(m);
    }
  }
  return unique.slice(0, 60);
}

// API: поиск
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json([]);
  const searchUrl = SEARCH_URL_TEMPLATE.replace('{query}', encodeURIComponent(query));
  const html = await fetchHTML(searchUrl);
  if (!html) return res.json([]);
  const movies = parseMoviesList(html);
  res.json(movies);
});

// API: каталог
app.get('/api/movies', async (req, res) => {
  const html = await fetchHTML(CATALOG_URL);
  if (!html) return res.status(500).json({ error: 'Не удалось загрузить каталог' });
  const movies = parseMoviesList(html);
  res.json(movies);
});

// API: детали фильма (не используется для редиректа, но оставим для совместимости)
app.get('/api/movie/:id', async (req, res) => {
  const id = req.params.id;
  let url;
  try {
    url = Buffer.from(id, 'base64').toString('utf8');
  } catch (e) {
    return res.status(400).json({ error: 'Неверный ID' });
  }
  if (!url || !url.startsWith(BASE_URL)) {
    return res.status(400).json({ error: 'Некорректная ссылка' });
  }
  // Для редиректа нам не нужно парсить страницу, просто возвращаем ссылку
  res.json({ type: 'redirect', url });
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Каталог: ${CATALOG_URL}`);
});
