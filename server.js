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

  // 1. Ищем карточки в типичных блоках DLE
  $('.short-items .item, .content .item, .items .item, .movie-item, .film-item').each((i, el) => {
    const $item = $(el);
    // Ищем ссылку внутри карточки
    const $link = $item.find('a').first();
    let link = $link.attr('href');
    if (!link) return;
    if (link.startsWith('/')) link = BASE_URL + link;
    if (!link.startsWith('http')) link = BASE_URL + '/' + link;
    // Отбрасываем мусор
    if (link.includes('/uploads/') || link.match(/\.(jpg|png|gif|jpeg|webp)$/i)) return;
    if (link === BASE_URL || link === BASE_URL + '/') return;
    
    let title = $link.attr('title') || $link.find('.title, h3').text().trim() || $link.text().trim();
    if (!title) title = $item.find('.title, h3').first().text().trim();
    if (!title) return;
    
    let poster = $item.find('img').first().attr('src');
    if (poster && poster.startsWith('/')) poster = BASE_URL + poster;
    
    let year = $item.find('.year, .date').first().text().trim() || '—';
    let rating = $item.find('.rating, .imdb').first().text().trim() || '—';
    
    movies.push({
      id: Buffer.from(link, 'utf8').toString('base64'),
      title,
      poster: poster || '/placeholder.jpg',
      year,
      rating,
      link
    });
  });
  
  // 2. Если не нашли – ищем все ссылки, которые ведут на /series/ или /film/ (признак страницы фильма)
  if (movies.length === 0) {
    $('a').each((i, el) => {
      const $a = $(el);
      let link = $a.attr('href');
      if (!link) return;
      if (link.startsWith('/')) link = BASE_URL + link;
      if (!link.startsWith('http')) return;
      // Фильтруем: только ссылки, содержащие /series/ или /film/ или цифровой ID
      if (!link.match(/\/(series|film|movie)\//) && !link.match(/\/\d+-[a-z0-9-]+\.html/)) return;
      if (link.includes('/uploads/')) return;
      
      const $img = $a.find('img');
      if ($img.length === 0) return;
      
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
  
  // Удаляем дубликаты
  const unique = [];
  const seen = new Set();
  for (const m of movies) {
    if (!seen.has(m.link)) {
      seen.add(m.link);
      unique.push(m);
    }
  }
  
  if (unique.length === 0) {
    console.error('Не найдено ни одной ссылки на фильм. Проверьте структуру страницы.');
  } else {
    console.log(`Найдено фильмов: ${unique.length}. Пример: ${unique[0].link}`);
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
