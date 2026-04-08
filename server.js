const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

// НАСТРОЙКИ ДЛЯ KINOGO.PRO
const BASE_URL = 'https://kinogo.pro';
const CATALOG_URL = process.env.CATALOG_URL || `${BASE_URL}/`;
const SEARCH_URL_TEMPLATE = process.env.SEARCH_URL_TEMPLATE || `${BASE_URL}/?do=search&subaction=search&q={query}`;

// Вспомогательная функция загрузки HTML
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

// Парсер списка фильмов (каталог / поиск)
function parseMoviesList(html, pageUrl) {
  const $ = cheerio.load(html);
  const movies = [];

  // На kinogo.pro карточки обычно лежат в .short-item или .item
  $('.short-item, .item, .movie-item, .film-item').each((i, el) => {
    const $card = $(el);
    let title = $card.find('.title, h3, .name').first().text().trim();
    let link = $card.find('a').first().attr('href');
    let poster = $card.find('img').first().attr('src');

    if (!title) {
      title = $card.find('a').first().attr('title') || '';
    }
    if (!link) return;

    if (link && !link.startsWith('http')) {
      link = BASE_URL + (link.startsWith('/') ? link : '/' + link);
    }
    if (poster && !poster.startsWith('http')) {
      poster = BASE_URL + (poster.startsWith('/') ? poster : '/' + poster);
    }

    // Год и рейтинг на kinogo.pro часто в .year, .rating
    let year = $card.find('.year, .date').first().text().trim() || '—';
    let rating = $card.find('.rating, .imdb, .rate').first().text().trim() || '—';

    movies.push({
      id: Buffer.from(link, 'utf8').toString('base64'),
      title: title || 'Без названия',
      poster: poster || '/placeholder.jpg',
      year,
      rating,
      link
    });
  });

  // Если не нашли карточки по селекторам выше – пробуем универсальный поиск (любые a с img)
  if (movies.length === 0) {
    $('a').each((i, el) => {
      const $a = $(el);
      const $img = $a.find('img');
      if ($img.length === 0) return;
      let title = $a.attr('title') || $img.attr('alt') || $a.find('h3, .title, .name').first().text().trim();
      if (!title) return;
      let poster = $img.attr('src');
      let link = $a.attr('href');
      if (link && !link.startsWith('http')) link = BASE_URL + (link.startsWith('/') ? link : '/' + link);
      if (!link || link === BASE_URL + '/') return;
      movies.push({
        id: Buffer.from(link, 'utf8').toString('base64'),
        title,
        poster: poster?.startsWith('http') ? poster : (poster ? BASE_URL + poster : '/placeholder.jpg'),
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

// Парсер страницы фильма (поиск iframe или прямой .m3u8)
async function parseMoviePage(url) {
  const html = await fetchHTML(url);
  if (!html) return null;
  const $ = cheerio.load(html);

  let iframeSrc = null;

  // 1. Поиск iframe плеера (наиболее частые классы/ID)
  const iframeSelectors = [
    '.embed-player iframe',
    '.video iframe',
    '#player iframe',
    '.player iframe',
    'iframe[src*="embed"]',
    'iframe[src*="video"]',
    'iframe[src*="kinostream"]',
    'iframe[src*="cdn"]'
  ];
  for (const sel of iframeSelectors) {
    const $iframe = $(sel).first();
    if ($iframe.length) {
      iframeSrc = $iframe.attr('src');
      break;
    }
  }

  // 2. Если iframe не найден, пробуем найти в data-атрибутах
  if (!iframeSrc) {
    iframeSrc = $('[data-player-url], [data-embed]').attr('data-player-url') ||
                $('[data-src*="iframe"]').attr('data-src');
  }

  // 3. Нормализация ссылки
  if (iframeSrc && !iframeSrc.startsWith('http')) {
    iframeSrc = BASE_URL + (iframeSrc.startsWith('/') ? iframeSrc : '/' + iframeSrc);
  }

  // 4. Если всё ещё нет iframe – ищем прямую ссылку на .m3u8 в скриптах или атрибутах
  if (!iframeSrc) {
    const scripts = $('script').map((i, el) => $(el).html()).get();
    for (let script of scripts) {
      if (script) {
        // Ищем .m3u8 ссылку
        let match = script.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/);
        if (match) {
          iframeSrc = match[0];
          break;
        }
        // Ищем ссылки на плеер в формате //site.com/embed/...
        match = script.match(/https?:\/\/[^"'\s]+\.(?:html|php)[^"'\s]*/);
        if (match && (match[0].includes('embed') || match[0].includes('player'))) {
          iframeSrc = match[0];
          break;
        }
      }
    }
  }

  // 5. Если ничего не нашли – отдаём саму страницу (запасной вариант, но может не встроиться)
  if (!iframeSrc) {
    iframeSrc = url;
  }

  // Дополнительно: пытаемся определить сезоны/серии (если нужно для сериалов)
  const seasons = [];
  $('.season-block, .seasons-list, .season-list').each((i, block) => {
    $(block).find('.season, .season-item').each((sIdx, seasonEl) => {
      const seasonName = $(seasonEl).find('.season-title, .title').text().trim() || `Сезон ${sIdx + 1}`;
      const episodes = [];
      $(seasonEl).find('.episode, .episode-item, .series-item').each((eIdx, epEl) => {
        let epTitle = $(epEl).find('.episode-title, .title').text().trim() || `Серия ${eIdx + 1}`;
        let epLink = $(epEl).find('a').attr('href');
        if (epLink && !epLink.startsWith('http')) epLink = BASE_URL + (epLink.startsWith('/') ? epLink : '/' + epLink);
        if (epLink) episodes.push({ title: epTitle, link: epLink });
      });
      if (episodes.length) seasons.push({ name: seasonName, episodes });
    });
  });

  if (seasons.length) {
    return { type: 'series', seasons, iframeSrc };
  }
  return { type: 'movie', iframeSrc };
}

// ---------- API маршруты ----------
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json([]);
  const searchUrl = SEARCH_URL_TEMPLATE.replace('{query}', encodeURIComponent(query));
  const html = await fetchHTML(searchUrl);
  if (!html) return res.json([]);
  const movies = parseMoviesList(html, searchUrl);
  res.json(movies);
});

app.get('/api/movies', async (req, res) => {
  const html = await fetchHTML(CATALOG_URL);
  if (!html) return res.status(500).json({ error: 'Не удалось загрузить каталог' });
  const movies = parseMoviesList(html, CATALOG_URL);
  res.json(movies);
});

app.get('/api/movie/:id', async (req, res) => {
  const id = req.params.id;
  let url;
  try {
    url = Buffer.from(id, 'base64').toString('utf8');
  } catch (e) {
    return res.status(400).json({ error: 'Неверный ID' });
  }
  if (!url?.startsWith(BASE_URL)) {
    return res.status(400).json({ error: 'Некорректная ссылка' });
  }
  const details = await parseMoviePage(url);
  if (!details) {
    return res.status(404).json({ error: 'Не удалось получить данные' });
  }
  res.json(details);
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Kinogo.pro каталог: ${CATALOG_URL}`);
});
