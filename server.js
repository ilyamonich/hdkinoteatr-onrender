const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

const BASE_URL = 'https://www.hdkinoteatr.com';

async function fetchHTML(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    console.error(`Ошибка загрузки ${url}:`, error.message);
    return null;
  }
}

// Универсальный парсер, ищет любые ссылки с картинками
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
      id: Buffer.from(link).toString('base64'),
      title,
      poster: poster && poster.startsWith('http') ? poster : (poster ? BASE_URL + poster : '/placeholder.jpg'),
      year,
      rating,
      link
    });
  });

  // Убираем дубликаты
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

async function parseMoviePage(url) {
  const html = await fetchHTML(url);
  if (!html) return null;
  const $ = cheerio.load(html);

  let iframeSrc = null;
  const $iframe = $('iframe').first();
  if ($iframe.length) {
    iframeSrc = $iframe.attr('src');
    if (iframeSrc && !iframeSrc.startsWith('http')) {
      iframeSrc = BASE_URL + iframeSrc;
    }
  }

  // Поиск сезонов (универсально)
  const seasons = [];
  $('.season-block, .seasons-list, .seasons').each((i, block) => {
    const $block = $(block);
    $block.find('.season, .season-item').each((sIdx, seasonEl) => {
      const seasonName = $(seasonEl).find('.season-title, .title').text().trim() || `Сезон ${sIdx + 1}`;
      const episodes = [];
      $(seasonEl).find('.episode, .episode-item, .series-item').each((eIdx, epEl) => {
        const epTitle = $(epEl).find('.episode-title, .title').text().trim() || `Серия ${eIdx + 1}`;
        let epLink = $(epEl).find('a').attr('href');
        if (epLink && !epLink.startsWith('http')) {
          epLink = BASE_URL + (epLink.startsWith('/') ? epLink : '/' + epLink);
        }
        episodes.push({ title: epTitle, link: epLink });
      });
      if (episodes.length) seasons.push({ name: seasonName, episodes });
    });
  });

  if (seasons.length > 0) {
    return { type: 'series', seasons, iframeSrc: iframeSrc || null };
  } else if (iframeSrc) {
    return { type: 'movie', iframeSrc };
  }
  return null;
}

// API: поиск
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json([]);
  try {
    const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(query)}`;
    const html = await fetchHTML(searchUrl);
    if (!html) return res.json([]);
    const movies = parseMoviesList(html, searchUrl);
    res.json(movies);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

// API: список фильмов (пробуем несколько возможных адресов)
app.get('/api/movies', async (req, res) => {
  const possibleUrls = [`${BASE_URL}/filmy`, `${BASE_URL}/movies`, `${BASE_URL}/catalog`, `${BASE_URL}/`];
  let movies = [];
  for (const url of possibleUrls) {
    const html = await fetchHTML(url);
    if (html) {
      movies = parseMoviesList(html, url);
      if (movies.length > 0) break;
    }
  }
  res.json(movies);
});

// API: детали
app.get('/api/movie/:id', async (req, res) => {
  const id = req.params.id;
  let url;
  try {
    url = Buffer.from(id, 'base64').toString('ascii');
  } catch (e) {
    return res.status(400).json({ error: 'Неверный ID' });
  }
  if (!url || !url.startsWith(BASE_URL)) {
    return res.status(400).json({ error: 'Некорректная ссылка' });
  }
  const details = await parseMoviePage(url);
  if (!details) {
    return res.status(404).json({ error: 'Не удалось получить данные со страницы' });
  }
  res.json(details);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
