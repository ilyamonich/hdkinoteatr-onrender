const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

const BASE_URL = 'https://www.hdkinoteatr.com';

// URL каталога и поиска – можно переопределить через переменные окружения
// По умолчанию используются актуальные адреса, которые вы указали
const CATALOG_URL = process.env.CATALOG_URL || `${BASE_URL}/catalog/`;
const SEARCH_URL_TEMPLATE = process.env.SEARCH_URL_TEMPLATE || `${BASE_URL}/index.php?do=search&subaction=search&q={query}`;

/**
 * Загрузка HTML страницы с нужными заголовками
 */
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

/**
 * Универсальный парсер списка фильмов (ищет любые ссылки с картинками)
 */
function parseMoviesList(html, pageUrl) {
  const $ = cheerio.load(html);
  const movies = [];

  $('a').each((i, el) => {
    const $a = $(el);
    const $img = $a.find('img');
    if ($img.length === 0) return;

    let title = $a.attr('title') || $img.attr('alt') || $a.find('h3, .title, .name').first().text().trim();
    if (!title) return;

    let poster = $img.attr('src');
    let link = $a.attr('href');
    if (link && !link.startsWith('http')) {
      link = BASE_URL + (link.startsWith('/') ? link : '/' + link);
    }
    if (!link || link === BASE_URL + '/') return;

    const $parent = $a.closest('div, article, li');
    let year = $parent.find('.year, .date, .info-year, .date-year').first().text().trim() || '—';
    let rating = $parent.find('.rating, .imdb, .rate, .stars').first().text().trim() || '—';

    movies.push({
      id: Buffer.from(link, 'utf8').toString('base64'),
      title,
      poster: poster && poster.startsWith('http') ? poster : (poster ? BASE_URL + poster : '/placeholder.jpg'),
      year,
      rating,
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
  return unique.slice(0, 60);
}

/**
 * Парсинг страницы фильма/сериала: поиск iframe, сезонов, серий
 */
async function parseMoviePage(url) {
  const html = await fetchHTML(url);
  if (!html) {
    console.error(`Не удалось получить HTML для ${url}`);
    return null;
  }
  const $ = cheerio.load(html);

  // Поиск iframe плеера (различные варианты селекторов)
  let iframeSrc = null;
  const iframeCandidates = [
    'iframe',
    '.video iframe',
    '.player iframe',
    '#player iframe',
    'div[data-player] iframe',
    'object[data*=".mp4"]'
  ];
  for (const sel of iframeCandidates) {
    const $iframe = $(sel).first();
    if ($iframe.length) {
      iframeSrc = $iframe.attr('src');
      break;
    }
  }

  if (iframeSrc && !iframeSrc.startsWith('http')) {
    iframeSrc = BASE_URL + (iframeSrc.startsWith('/') ? iframeSrc : '/' + iframeSrc);
  }

  // Если iframe не найден, ищем video-тег
  if (!iframeSrc) {
    const $video = $('video source').first();
    if ($video.length) {
      iframeSrc = $video.attr('src');
    } else {
      const mp4Link = $('[src$=".mp4"], [data-src$=".mp4"], [src$=".m3u8"]').attr('src');
      if (mp4Link) iframeSrc = mp4Link;
    }
  }

  // Поиск сезонов и серий (для сериалов)
  const seasons = [];
  $('.season-block, .seasons-list, .seasons, .series-list, .episodes-list').each((i, block) => {
    const $block = $(block);
    $block.find('.season, .season-item, .season-block').each((sIdx, seasonEl) => {
      const seasonName = $(seasonEl).find('.season-title, .title, h3, h4').first().text().trim() || `Сезон ${sIdx + 1}`;
      const episodes = [];
      $(seasonEl).find('.episode, .episode-item, .series-item, .episodes a').each((eIdx, epEl) => {
        let epTitle = $(epEl).find('.episode-title, .title, span').first().text().trim();
        if (!epTitle) epTitle = `Серия ${eIdx + 1}`;
        let epLink = $(epEl).is('a') ? $(epEl).attr('href') : $(epEl).find('a').attr('href');
        if (epLink && !epLink.startsWith('http')) {
          epLink = BASE_URL + (epLink.startsWith('/') ? epLink : '/' + epLink);
        }
        if (epLink) episodes.push({ title: epTitle, link: epLink });
      });
      if (episodes.length) seasons.push({ name: seasonName, episodes });
    });
  });

  if (seasons.length > 0) {
    return { type: 'series', seasons, iframeSrc: iframeSrc || null };
  } else if (iframeSrc) {
    return { type: 'movie', iframeSrc };
  } else {
    console.error(`Не найден плеер на странице ${url}`);
    return null;
  }
}

// ---------- API маршруты ----------

// Поиск фильмов
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json([]);
  try {
    const searchUrl = SEARCH_URL_TEMPLATE.replace('{query}', encodeURIComponent(query));
    const html = await fetchHTML(searchUrl);
    if (!html) return res.json([]);
    const movies = parseMoviesList(html, searchUrl);
    res.json(movies);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

// Список фильмов (каталог)
app.get('/api/movies', async (req, res) => {
  const html = await fetchHTML(CATALOG_URL);
  if (!html) {
    return res.status(500).json({ error: 'Не удалось загрузить каталог. Проверьте CATALOG_URL' });
  }
  const movies = parseMoviesList(html, CATALOG_URL);
  res.json(movies);
});

// Детальная страница фильма/сериала
app.get('/api/movie/:id', async (req, res) => {
  const id = req.params.id;
  let url;
  try {
    url = Buffer.from(id, 'base64').toString('utf8');
    console.log(`Декодирован URL: ${url}`);
  } catch (e) {
    console.error('Ошибка декодирования base64:', e);
    return res.status(400).json({ error: 'Неверный ID' });
  }

  if (!url || !url.startsWith(BASE_URL)) {
    console.warn(`URL не начинается с ${BASE_URL}: ${url}`);
    return res.status(400).json({ error: 'Некорректная ссылка' });
  }

  const details = await parseMoviePage(url);
  if (!details) {
    console.error(`Не удалось распарсить страницу: ${url}`);
    return res.status(404).json({ error: 'Не удалось получить данные со страницы. Возможно, плеер защищён или страница изменилась.' });
  }
  res.json(details);
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Каталог: ${CATALOG_URL}`);
  console.log(`Шаблон поиска: ${SEARCH_URL_TEMPLATE}`);
});
