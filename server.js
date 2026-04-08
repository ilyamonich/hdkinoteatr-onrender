const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

const BASE_URL = 'https://www.hdkinoteatr.com';
const CATALOG_URL = process.env.CATALOG_URL || `${BASE_URL}/catalog/`;
const SEARCH_URL_TEMPLATE = process.env.SEARCH_URL_TEMPLATE || `${BASE_URL}/index.php?do=search&subaction=search&q={query}`;

// Кэш для страниц фильмов (на 1 час)
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 час

// Один экземпляр браузера для всех запросов
let browserInstance = null;
let browserInitPromise = null;

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }
  if (browserInitPromise) {
    return browserInitPromise;
  }
  browserInitPromise = puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: 'new'
  }).then(browser => {
    browserInstance = browser;
    browserInitPromise = null;
    return browserInstance;
  }).catch(err => {
    browserInitPromise = null;
    throw err;
  });
  return browserInitPromise;
}

// --------------------------------------------------------------
// 1. Вспомогательная функция загрузки HTML через axios (для списков)
// --------------------------------------------------------------
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

// --------------------------------------------------------------
// 2. Парсер списка фильмов (работает на статическом HTML)
// --------------------------------------------------------------
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

// --------------------------------------------------------------
// 3. Парсер страницы фильма/сериала с переиспользованием браузера
// --------------------------------------------------------------
async function parseMoviePage(url) {
  // Проверяем кэш
  const cached = cache.get(url);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    console.log(`[CACHE] Использую кэш для ${url}`);
    return cached.data;
  }

  let page = null;
  try {
    console.log(`[PUPPETEER] Загружаю страницу: ${url}`);
    const browser = await getBrowser();
    page = await browser.newPage();
    
    // Устанавливаем таймаут загрузки 30 секунд
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Ждём iframe не более 10 секунд
    await page.waitForSelector('iframe', { timeout: 10000 }).catch(() => console.log('Iframe не найден, продолжаем...'));
    
    const data = await page.evaluate(() => {
      let iframeSrc = null;
      const iframe = document.querySelector('iframe');
      if (iframe && iframe.src) iframeSrc = iframe.src;
      if (!iframeSrc) {
        const video = document.querySelector('video source');
        if (video && video.src) iframeSrc = video.src;
      }
      
      const seasons = [];
      document.querySelectorAll('.season-block, .seasons-list, .seasons').forEach(block => {
        block.querySelectorAll('.season, .season-item').forEach(seasonEl => {
          const seasonName = seasonEl.querySelector('.season-title, .title')?.innerText.trim() || `Сезон ${seasons.length + 1}`;
          const episodes = [];
          seasonEl.querySelectorAll('.episode, .episode-item, .series-item').forEach(epEl => {
            let epTitle = epEl.querySelector('.episode-title, .title')?.innerText.trim() || `Серия ${episodes.length + 1}`;
            let epLink = epEl.querySelector('a')?.href;
            if (epLink) episodes.push({ title: epTitle, link: epLink });
          });
          if (episodes.length) seasons.push({ name: seasonName, episodes });
        });
      });
      return { iframeSrc, seasons };
    });
    
    await page.close();
    
    let result = null;
    if (data.seasons && data.seasons.length > 0) {
      result = { type: 'series', seasons: data.seasons, iframeSrc: data.iframeSrc || null };
    } else if (data.iframeSrc) {
      result = { type: 'movie', iframeSrc: data.iframeSrc };
    } else {
      console.error(`[PUPPETEER] Не найден плеер на странице: ${url}`);
      return null;
    }
    
    // Сохраняем в кэш
    cache.set(url, { timestamp: Date.now(), data: result });
    return result;
  } catch (error) {
    console.error(`[PUPPETEER] Ошибка при обработке ${url}:`, error.message);
    if (page) await page.close().catch(e => console.log(e));
    return null;
  }
}

// --------------------------------------------------------------
// 4. API маршруты
// --------------------------------------------------------------
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

app.get('/api/movies', async (req, res) => {
  const html = await fetchHTML(CATALOG_URL);
  if (!html) {
    return res.status(500).json({ error: 'Не удалось загрузить каталог. Проверьте CATALOG_URL' });
  }
  const movies = parseMoviesList(html, CATALOG_URL);
  res.json(movies);
});

app.get('/api/movie/:id', async (req, res) => {
  const id = req.params.id;
  let url;
  try {
    url = Buffer.from(id, 'base64').toString('utf8');
    console.log(`Декодирован URL: ${url}`);
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

// Graceful shutdown: закрываем браузер при остановке сервера
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing browser...');
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Каталог: ${CATALOG_URL}`);
  console.log(`Шаблон поиска: ${SEARCH_URL_TEMPLATE}`);
  console.log(`Puppeteer браузер будет создан при первом запросе к фильму`);
});
