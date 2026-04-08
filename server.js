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

  // Анализируем структуру страницы /catalog/
  // Ищем все блоки, которые содержат ссылку и картинку
  $('.short-items .item, .items .item, .movie-item, .film-item, .item').each((i, el) => {
    const $item = $(el);
    // Ищем первую ссылку внутри блока, которая ведёт не на картинку и не на главную
    const $link = $item.find('a').filter((idx, a) => {
      const href = $(a).attr('href');
      return href && !href.includes('/uploads/') && !href.match(/\.(jpg|png|gif|jpeg)$/i) && href !== '/' && href !== '';
    }).first();
    
    let link = $link.attr('href');
    if (!link) return;
    
    // Преобразуем относительную ссылку в абсолютную
    if (link.startsWith('/')) {
      link = BASE_URL + link;
    } else if (!link.startsWith('http')) {
      link = BASE_URL + '/' + link;
    }
    
    // Игнорируем ссылки на главную или служебные
    if (link === BASE_URL || link === BASE_URL + '/' || link.includes('/catalog/')) return;
    
    // Название
    let title = $link.attr('title') || $link.text().trim();
    if (!title) title = $item.find('.title, h3, .name').first().text().trim();
    if (!title) return;
    
    // Постер
    let poster = $item.find('img').first().attr('src');
    if (poster && poster.startsWith('/')) poster = BASE_URL + poster;
    
    // Год и рейтинг (если есть)
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
  
  // Если не нашли ни одного фильма – пробуем универсальный поиск всех ссылок с картинками
  if (movies.length === 0) {
    $('a').each((i, el) => {
      const $a = $(el);
      const $img = $a.find('img');
      if ($img.length === 0) return;
      let link = $a.attr('href');
      if (!link) return;
      if (link.startsWith('/')) link = BASE_URL + link;
      if (!link.startsWith('http')) link = BASE_URL + '/' + link;
      // Исключаем главную, страницы пагинации, картинки
      if (link === BASE_URL || link === BASE_URL + '/' || link.includes('/catalog/') || link.includes('/uploads/')) return;
      if (link.match(/\.(jpg|png|gif|jpeg|webp)$/i)) return;
      
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
  
  // Удаляем дубликаты по ссылке
  const unique = [];
  const seen = new Set();
  for (const m of movies) {
    if (!seen.has(m.link)) {
      seen.add(m.link);
      unique.push(m);
    }
  }
  // Логируем первую найденную ссылку для отладки
  if (unique.length > 0) {
    console.log(`Найдено фильмов: ${unique.length}. Пример ссылки: ${unique[0].link}`);
  } else {
    console.log('Фильмы не найдены. Проверьте селекторы.');
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
