const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Логирование всех необработанных ошибок
process.on('uncaughtException', (error) => {
    console.error('Необработанная ошибка:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Необработанное отклонение промиса:', error);
});

// Логирование переменных окружения (без приватных данных)
console.log('Режим запуска:', process.env.NODE_ENV);
console.log('Порт:', process.env.PORT);
console.log('Email сервисного аккаунта настроен:', !!process.env.GOOGLE_CLIENT_EMAIL);
console.log('Приватный ключ настроен:', !!process.env.GOOGLE_PRIVATE_KEY);

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
        console.log(`Получение данных из таблицы. Диапазон: ${range}, Лист: ${sheetName}`);
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `'${sheetName}'!${range}`
        });

        console.log(`Получено строк: ${response.data.values?.length || 0}`);
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
        console.error('Детали ошибки:', {
            message: error.message,
            code: error.code,
            stack: error.stack,
            response: error.response?.data
        });
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

// Эндпоинт для проверки статуса
app.get('/status', (req, res) => {
    res.json({
        status: 'ok',
        lastUpdate: {
            today: new Date(cache.today.lastUpdate).toISOString(),
            yesterday: new Date(cache.yesterday.lastUpdate).toISOString()
        }
    });
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

// Функция для поддержания сервера активным
function keepAlive() {
    const INTERVAL = 14 * 60 * 1000; // 14 минут
    setInterval(() => {
        const now = new Date().toLocaleTimeString();
        console.log(`[${now}] Сервер активен`);
        // Обновляем кеш, если нужно
        getCachedData('today').catch(console.error);
        getCachedData('yesterday').catch(console.error);
    }, INTERVAL);
}

app.listen(port, () => {
    console.log(`Сервер запущен на порту ${port}`);
    console.log('Версия Node.js:', process.version);
    console.log('Платформа:', process.platform);
    initializeCache();
    keepAlive(); // Запускаем поддержание активности
}); 