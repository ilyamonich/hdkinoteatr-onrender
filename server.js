const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
// Render передаёт порт через переменную окружения PORT
const PORT = process.env.PORT || 3000;

// Раздаём статические файлы из папки public
app.use(express.static('public'));

const BASE_URL = 'https://www.hdkinoteatr.com';

// Селекторы (можно при необходимости подстроить под актуальную вёрстку)
const SELECTORS = {
  movieCard: '.movie-item, .film-item, .item',
  title: '.title, .name, h3',
  poster: 'img',
  year: '.year, .date',
  rating: '.rating, .imdb',
  link: 'a',
  iframePlayer: 'iframe',
  seasonBlock: '.season-block, .seasons',
  seasonItem: '.season',
  episodeItem: '.episode',
  episodeLink: 'a'
};

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

function parseMoviesList(html, pageUrl) {
  const $ = cheerio.load(html);
  const movies = [];

  $(SELECTORS.movieCard).each((i, el) => {
    const $card = $(el);
    let title = $card.find(SELECTORS.title).first().text().trim();
    const poster = $card.find(SELECTORS.poster).attr('src');
    const year = $card.find(SELECTORS.year).first().text().trim();
    const rating = $card.find(SELECTORS.rating).first().text().trim();
    let link = $card.find(SELECTORS.link).attr('href');

    if (!title && $card.find('a').first().attr('title')) {
      title = $card.find('a').first().attr('title');
    }
    if (link && !link.startsWith('http')) {
      link = BASE_URL + (link.startsWith('/') ? link : '/' + link);
    }
    if (title) {
      movies.push({
        id: Buffer.from(link).toString('base64'),
        title,
        poster: poster && poster.startsWith('http') ? poster : (poster ? BASE_URL + poster : '/placeholder.jpg'),
        year: year || '—',
        rating: rating || '—',
        link
      });
    }
  });
  return movies;
}

async function parseMoviePage(url) {
  const html = await fetchHTML(url);
  if (!html) return null;
  const $ = cheerio.load(html);

  let iframeSrc = null;
  const $iframe = $(SELECTORS.iframePlayer).first();
  if ($iframe.length) {
    iframeSrc = $iframe.attr('src');
    if (iframeSrc && !iframeSrc.startsWith('http')) {
      iframeSrc = BASE_URL + iframeSrc;
    }
  }

  const seasons = [];
  const $seasonsBlock = $(SELECTORS.seasonBlock);
  if ($seasonsBlock.length) {
    $seasonsBlock.find(SELECTORS.seasonItem).each((sIdx, seasonEl) => {
      const seasonName = $(seasonEl).find('.season-title').text().trim() || `Сезон ${sIdx + 1}`;
      const episodes = [];
      $(seasonEl).find(SELECTORS.episodeItem).each((eIdx, epEl) => {
        const epTitle = $(epEl).find('.episode-title').text().trim() || `Серия ${eIdx + 1}`;
        let epLink = $(epEl).find(SELECTORS.episodeLink).attr('href');
        if (epLink && !epLink.startsWith('http')) {
          epLink = BASE_URL + (epLink.startsWith('/') ? epLink : '/' + epLink);
        }
        episodes.push({ title: epTitle, link: epLink });
      });
      seasons.push({ name: seasonName, episodes });
    });
  }

  if (seasons.length === 0 && iframeSrc) {
    return { type: 'movie', iframeSrc };
  } else if (seasons.length > 0) {
    return { type: 'series', seasons, iframeSrc: iframeSrc || null };
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

// API: список фильмов (главная страница /filmy)
app.get('/api/movies', async (req, res) => {
  try {
    const catalogUrl = `${BASE_URL}/filmy`;
    const html = await fetchHTML(catalogUrl);
    if (!html) return res.json([]);
    const movies = parseMoviesList(html, catalogUrl);
    res.json(movies);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка загрузки списка' });
  }
});

// API: детали фильма/сериала
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

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
