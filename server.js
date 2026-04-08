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
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
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
    const $parent = $a.closest('div, article, li');
    let year = $parent.find('.year, .date').first().text().trim() || '—';
    let rating = $parent.find('.rating, .imdb').first().text().trim() || '—';
    movies.push({
      id: Buffer.from(link, 'utf8').toString('base64'),
      title,
      poster: poster?.startsWith('http') ? poster : (poster ? BASE_URL + poster : '/placeholder.jpg'),
      year,
      rating,
      link
    });
  });
  const unique = [];
  const seen = new Set();
  for (const m of movies) if (!seen.has(m.link)) { seen.add(m.link); unique.push(m); }
  return unique.slice(0, 60);
}

async function parseMoviePage(url) {
  const html = await fetchHTML(url);
  if (!html) return null;
  const $ = cheerio.load(html);
  let iframeSrc = null;
  // Попытка найти iframe
  iframeSrc = $('iframe').attr('src');
  if (!iframeSrc) iframeSrc = $('[data-src*="iframe"], [data-url*="player"]').attr('data-src');
  if (!iframeSrc) iframeSrc = $('video source').attr('src');
  if (!iframeSrc) {
    const match = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (match) iframeSrc = match[1];
  }
  if (iframeSrc && !iframeSrc.startsWith('http')) {
    iframeSrc = BASE_URL + (iframeSrc.startsWith('/') ? iframeSrc : '/' + iframeSrc);
  }
  // Если ничего не нашли – возвращаем ссылку на всю страницу (чтобы показать в iframe)
  if (!iframeSrc) iframeSrc = url;
  
  // Парсинг сезонов (упрощённо)
  const seasons = [];
  $('.season-block, .seasons-list').each((i, block) => {
    $(block).find('.season, .season-item').each((sIdx, seasonEl) => {
      const seasonName = $(seasonEl).find('.season-title, .title').text().trim() || `Сезон ${sIdx + 1}`;
      const episodes = [];
      $(seasonEl).find('.episode, .episode-item').each((eIdx, epEl) => {
        let epTitle = $(epEl).find('.episode-title, .title').text().trim() || `Серия ${eIdx + 1}`;
        let epLink = $(epEl).find('a').attr('href');
        if (epLink && !epLink.startsWith('http')) epLink = BASE_URL + (epLink.startsWith('/') ? epLink : '/' + epLink);
        if (epLink) episodes.push({ title: epTitle, link: epLink });
      });
      if (episodes.length) seasons.push({ name: seasonName, episodes });
    });
  });
  if (seasons.length) return { type: 'series', seasons, iframeSrc };
  return { type: 'movie', iframeSrc };
}

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json([]);
  const searchUrl = SEARCH_URL_TEMPLATE.replace('{query}', encodeURIComponent(query));
  const html = await fetchHTML(searchUrl);
  if (!html) return res.json([]);
  res.json(parseMoviesList(html));
});

app.get('/api/movies', async (req, res) => {
  const html = await fetchHTML(CATALOG_URL);
  if (!html) return res.status(500).json({ error: 'Не удалось загрузить каталог' });
  res.json(parseMoviesList(html));
});

app.get('/api/movie/:id', async (req, res) => {
  const id = req.params.id;
  let url;
  try { url = Buffer.from(id, 'base64').toString('utf8'); } catch (e) { return res.status(400).json({ error: 'Неверный ID' }); }
  if (!url?.startsWith(BASE_URL)) return res.status(400).json({ error: 'Некорректная ссылка' });
  const details = await parseMoviePage(url);
  if (!details) return res.status(404).json({ error: 'Не удалось получить данные' });
  res.json(details);
});

app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
