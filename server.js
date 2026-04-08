const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

const BASE_URL = 'https://www.hdkinoteatr.com';
const CATALOG_URL = process.env.CATALOG_URL || `${BASE_URL}/catalog/`;

// Универсальная функция загрузки (GET/POST)
async function fetchHTML(url, options = {}) {
  try {
    const response = await axios({
      method: options.method || 'GET',
      url: url,
      data: options.data || null,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...options.headers
      },
      timeout: 15000
    });
    return response.data;
  } catch (error) {
    console.error(`Ошибка загрузки ${url}:`, error.message);
    return null;
  }
}

// Функция поиска через POST (эмуляция формы поиска)
async function searchMovies(query) {
  const formData = new URLSearchParams();
  formData.append('do', 'search');
  formData.append('subaction', 'search');
  formData.append('story', query);
  // Добавляем параметр search_start (как в форме)
  formData.append('search_start', '0');
  const html = await fetchHTML(`${BASE_URL}/index.php?do=search`, {
    method: 'POST',
    data: formData.toString(),
    headers: {
      'Referer': BASE_URL,
      'Origin': BASE_URL
    }
  });
  return html;
}

// Парсинг списка фильмов (общий для каталога, категорий и поиска)
function parseMoviesList(html) {
  const $ = cheerio.load(html);
  const movies = [];

  // Основные карточки на странице /catalog/ и в результатах поиска
  $('.base.shortstory').each((i, el) => {
    const $card = $(el);
    const $titleLink = $card.find('h2.btl a').first();
    let link = $titleLink.attr('href');
    if (!link) return;
    if (link.startsWith('/')) link = BASE_URL + link;
    else if (!link.startsWith('http')) link = BASE_URL + '/' + link;

    let title = $titleLink.text().trim();
    if (!title) return;

    let poster = $card.find('.img img').first().attr('src');
    if (poster && poster.startsWith('/')) poster = BASE_URL + poster;

    let year = '—';
    const yearMatch = title.match(/(\d{4})/);
    if (yearMatch) year = yearMatch[1];

    movies.push({
      id: Buffer.from(link, 'utf8').toString('base64'),
      title,
      poster: poster || '/placeholder.jpg',
      year,
      rating: '—',
      link
    });
  });

  // Удаляем дубликаты
  const unique = [];
  const seen = new Set();
  for (const m of movies) {
    if (!seen.has(m.link)) {
      seen.add(m.link);
      unique.push(m);
    }
  }
  console.log(`Найдено фильмов: ${unique.length}`);
  return unique.slice(0, 60);
}

// Парсинг категорий из левой колонки (главная страница)
async function fetchCategories() {
  const html = await fetchHTML(BASE_URL);
  if (!html) return [];
  const $ = cheerio.load(html);
  const categories = [];
  $('.leftcol .cats li a').each((i, el) => {
    const $a = $(el);
    let link = $a.attr('href');
    if (link && link.startsWith('/')) link = BASE_URL + link;
    const name = $a.text().trim();
    if (name && link && !link.includes('/year/')) {
      categories.push({ name, link });
    }
  });
  return categories;
}

// ---------- API маршруты ----------
app.get('/api/categories', async (req, res) => {
  const cats = await fetchCategories();
  res.json(cats);
});

app.get('/api/category', async (req, res) => {
  let url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (url.startsWith('/')) url = BASE_URL + url;
  if (!url.startsWith(BASE_URL)) url = BASE_URL + url;
  const html = await fetchHTML(url);
  if (!html) return res.status(500).json({ error: 'Не удалось загрузить категорию' });
  const movies = parseMoviesList(html);
  res.json(movies);
});

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json([]);
  const html = await searchMovies(query);
  if (!html) return res.json([]);
  const movies = parseMoviesList(html);
  res.json(movies);
});

app.get('/api/movies', async (req, res) => {
  const html = await fetchHTML(CATALOG_URL);
  if (!html) return res.status(500).json({ error: 'Не удалось загрузить каталог' });
  const movies = parseMoviesList(html);
  res.json(movies);
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Каталог: ${CATALOG_URL}`);
});
