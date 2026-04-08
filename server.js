const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

const BASE_URL = 'https://www.hdkinoteatr.com';
const CATALOG_URL = process.env.CATALOG_URL || `${BASE_URL}/catalog/`;
const SEARCH_URL_TEMPLATE = process.env.SEARCH_URL_TEMPLATE || `${BASE_URL}/index.php?do=search&subaction=search&q={query}`;

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

function parseMoviesList(html) {
  const $ = cheerio.load(html);
  const movies = [];

  // Ищем все карточки фильмов (на странице /catalog/ они имеют класс base shortstory)
  $('.base.shortstory').each((i, el) => {
    const $card = $(el);
    // Ссылка на страницу фильма находится в h2.btl > a
    const $titleLink = $card.find('h2.btl a').first();
    let link = $titleLink.attr('href');
    if (!link) return;
    if (link.startsWith('/')) link = BASE_URL + link;
    else if (!link.startsWith('http')) link = BASE_URL + '/' + link;
    // Название фильма
    let title = $titleLink.text().trim();
    if (!title) return;
    // Постер: в .img img
    let poster = $card.find('.img img').first().attr('src');
    if (poster && poster.startsWith('/')) poster = BASE_URL + poster;
    // Год (часто в заголовке в скобках) – можно извлечь, но не обязательно
    let year = '—';
    const yearMatch = title.match(/(\d{4})/);
    if (yearMatch) year = yearMatch[1];
    // Рейтинг (можно поискать, но оставим пока '—')
    let rating = '—';
    movies.push({
      id: Buffer.from(link, 'utf8').toString('base64'),
      title,
      poster: poster || '/placeholder.jpg',
      year,
      rating,
      link
    });
  });

  // Если не нашли карточки – пробуем универсальный метод (на всякий случай)
  if (movies.length === 0) {
    console.log('Не найдено .base.shortstory, пробуем универсальный поиск...');
    $('a').each((i, el) => {
      const $a = $(el);
      const $img = $a.find('img');
      if ($img.length === 0) return;
      let link = $a.attr('href');
      if (!link) return;
      if (link.startsWith('/')) link = BASE_URL + link;
      if (!link.startsWith('http')) return;
      // Игнорируем ссылки на картинки, загрузки, главную
      if (link.includes('/uploads/') || link.match(/\.(jpg|png|gif|jpeg|webp)$/i)) return;
      if (link === BASE_URL || link === BASE_URL + '/') return;
      let title = $a.attr('title') || $img.attr('alt') || $a.text().trim();
      if (!title) return;
      let poster = $img.attr('src');
      if (poster && poster.startsWith('/')) poster = BASE_URL + poster;
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

  // Убираем дубликаты
  const unique = [];
  const seen = new Set();
  for (const m of movies) {
    if (!seen.has(m.link)) {
      seen.add(m.link);
      unique.push(m);
    }
  }
  console.log(`Найдено фильмов: ${unique.length}`);
  if (unique.length > 0) {
    console.log(`Пример ссылки: ${unique[0].link}`);
  } else {
    console.error('Не найдено ни одного фильма. Проверьте селекторы.');
  }
  return unique.slice(0, 60);
}

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json([]);
  const searchUrl = SEARCH_URL_TEMPLATE.replace('{query}', encodeURIComponent(query));
  const html = await fetchHTML(searchUrl);
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
