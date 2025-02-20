const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const http = require('http');
const https = require('https');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Кеш для хранения данных
const cache = {
    today: {
        data: null,
        lastUpdate: 0
    },
    yesterday: {
        data: null,
        lastUpdate: 0
    }
};

// Время жизни кеша (1 час)
const CACHE_TTL = 60 * 60 * 1000;

// Конфигурация Google Sheets API
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
});

const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = '1KyujbMsY2qGHMTnYSySgqdTY0vT66pjYMHTJ6dOkgGs';

// Функция для получения данных из таблицы
async function getSheetData(range, sheetName) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `'${sheetName}'!${range}`
        });

        const rows = response.data.values || [];
        return rows.map(row => ({
            rank: row[0] || '',
            phone: row[1] || '',
            orders: row[5] || '',
            hours: row[6] || '',
            money: row[9] || '',
            moneyPerHour: row[8] || ''
        }));
    } catch (error) {
        console.error('Ошибка при получении данных:', error);
        throw error;
    }
}

// Функция для получения данных с кешированием
async function getCachedData(type) {
    const cacheEntry = cache[type];
    const now = Date.now();

    // Проверяем, нужно ли обновить кеш
    if (!cacheEntry.data || now - cacheEntry.lastUpdate > CACHE_TTL) {
        try {
            const sheetName = type === 'today' ? 'выводДеньДеньги (СЕГОДНЯ)' : 'выводДеньДеньги (ВЧЕРА)';
            cacheEntry.data = await getSheetData('C20:L29', sheetName);
            cacheEntry.lastUpdate = now;
            console.log(`Кеш обновлен для ${type} в ${new Date().toLocaleTimeString()}`);
        } catch (error) {
            // Если произошла ошибка и у нас есть старые данные, используем их
            if (cacheEntry.data) {
                console.warn(`Ошибка обновления кеша для ${type}, используем старые данные`);
            } else {
                throw error;
            }
        }
    }

    return cacheEntry.data;
}

// Эндпоинт для пинга
app.get('/ping', (req, res) => {
    res.send('pong');
});

// Эндпоинт для получения данных за сегодня
app.get('/top/money/today', async (req, res) => {
    try {
        const data = await getCachedData('today');
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Эндпоинт для получения данных за вчера
app.get('/top/money/yesterday', async (req, res) => {
    try {
        const data = await getCachedData('yesterday');
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Инициализация кеша при запуске сервера
async function initializeCache() {
    try {
        await getCachedData('today');
        await getCachedData('yesterday');
        console.log('Кеш успешно инициализирован');
    } catch (error) {
        console.error('Ошибка при инициализации кеша:', error);
    }
}

// Функция самопинга
function setupPing() {
    const PING_INTERVAL = 14 * 60 * 1000; // 14 минут
    const appUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
    
    setInterval(() => {
        const url = new URL(appUrl + '/ping');
        const httpModule = url.protocol === 'https:' ? https : http;
        
        const pingPromise = new Promise((resolve, reject) => {
            httpModule.get(url, (res) => {
                if (res.statusCode === 200) {
                    console.log(`[${new Date().toLocaleTimeString()}] Пинг успешен`);
                    resolve();
                } else {
                    reject(new Error(`Пинг неудачен: ${res.statusCode}`));
                }
            }).on('error', (err) => {
                console.error('Ошибка пинга:', err);
                reject(err);
            });
        });

        // Обработка ошибок пинга
        pingPromise.catch((error) => {
            console.error('Ошибка при выполнении пинга:', error);
        });
    }, PING_INTERVAL);
}

app.listen(port, () => {
    console.log(`Сервер запущен на порту ${port}`);
    initializeCache();
    setupPing(); // Запускаем самопинг
}); 