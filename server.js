const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const https = require('https');
const schedule = require('node-schedule');
require('dotenv').config();

// Устанавливаем часовой пояс для Москвы
process.env.TZ = 'Europe/Moscow';
console.log('Текущее время сервера (МСК):', new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }));

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

// Время жизни кеша (5 минут)
const CACHE_TTL = 2 * 60 * 1000;

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
            console.log(`Кэш обновлен для ${type} в ${new Date().toLocaleTimeString()}`);
        } catch (error) {
            console.error(`Ошибка обновления кеша для ${type}:`, error);
            // Если произошла ошибка и у нас есть старые данные, используем их
            if (cacheEntry.data) {
                console.warn(`Используем старые данные для ${type}`);
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

// Эндпоинт для принудительного обновления кэша
app.get('/refresh', async (req, res) => {
    try {
        console.log('Принудительное обновление кэша...');
        await Promise.all([
            getCachedData('today'),
            getCachedData('yesterday')
        ]);
        
        // Сбрасываем время последнего обновления
        cache.today.lastUpdate = 0;
        cache.yesterday.lastUpdate = 0;
        
        // Получаем свежие данные
        const [todayData, yesterdayData] = await Promise.all([
            getCachedData('today'),
            getCachedData('yesterday')
        ]);

        res.json({
            status: 'success',
            message: 'Кэш успешно обновлен',
            data: {
                today: todayData,
                yesterday: yesterdayData
            }
        });
    } catch (error) {
        console.error('Ошибка при обновлении кэша:', error);
        res.status(500).json({
            status: 'error',
            message: 'Ошибка при обновлении кэша',
            error: error.message
        });
    }
});

// Функция для запуска скрипта
async function runScript() {
    try {
        const scriptUrl = process.env.GOOGLE_SCRIPT_URL;
        
        if (!scriptUrl) {
            throw new Error('URL скрипта не настроен');
        }

        const scriptPromise = new Promise((resolve, reject) => {
            https.get(scriptUrl, (response) => {
                if (response.statusCode === 200 || response.statusCode === 302) {
                    console.log(`Скрипт успешно запущен по расписанию (код ${response.statusCode})`);
                    resolve();
                } else {
                    reject(new Error(`Ошибка запуска скрипта: ${response.statusCode}`));
                }

                let data = '';
                response.on('data', (chunk) => {
                    data += chunk;
                });
                response.on('end', () => {
                    console.log('Ответ от скрипта:', data);
                });
            }).on('error', (err) => {
                console.error('Ошибка сетевого запроса:', err);
                reject(err);
            });
        });

        await scriptPromise;
        return { status: 'success', message: 'Скрипт успешно запущен' };
    } catch (error) {
        console.error('Ошибка при запуске скрипта по расписанию:', error);
        return { status: 'error', message: error.message };
    }
}

// Эндпоинт для запуска Google Apps Script функции
app.get('/runTransactionsForCurrentDate', async (req, res) => {
    try {
        const result = await runScript();
        if (result.status === 'success') {
            res.json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        res.status(500).json({ 
            status: 'error', 
            message: 'Ошибка при запуске скрипта',
            error: error.message 
        });
    }
});

// Функция настройки расписания
function setupSchedule() {
    // Массив с временем запуска (часы)
    const scheduleHours = [7, 11, 15, 19, 23];
    const scheduleMinutes = 50;

    // Создаем задачи для каждого времени
    const jobs = scheduleHours.map(hour => {
        const cronExpression = `${scheduleMinutes} ${hour} * * *`;
        const job = schedule.scheduleJob(cronExpression, async () => {
            console.log(`[${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}] Запуск скрипта по расписанию...`);
            const result = await runScript();
            console.log('Результат выполнения по расписанию:', result);
        });
        return { hour, job };
    });

    // Логируем все запланированные запуски
    console.log('Запланированные запуски (МСК):');
    jobs.forEach(({ hour, job }) => {
        const nextRun = job.nextInvocation().toLocaleString('ru-RU', { 
            timeZone: 'Europe/Moscow',
            hour12: false,
            hour: '2-digit',
            minute: '2-digit'
        });
        console.log(`- ${hour}:${scheduleMinutes} (следующий запуск: ${nextRun})`);
    });
}

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
    const INTERVAL = 2 * 60 * 1000; // 2 минуты
    
    function ping() {
        const now = new Date().toLocaleTimeString();
        console.log(`[${now}] Поддержание сервера активным...`);

        // Определяем, какой протокол и URL использовать
        const baseUrl = process.env.RENDER_EXTERNAL_URL 
            ? `https://${process.env.RENDER_EXTERNAL_URL}`
            : `http://localhost:${port}`;

        // Создаем реальный HTTP-запрос к серверу
        const requestModule = baseUrl.startsWith('https') ? https : require('http');
        
        requestModule.get(`${baseUrl}/status`, (resp) => {
            if (resp.statusCode === 200) {
                console.log(`[${now}] Сервер активен (статус: ${resp.statusCode})`);
            } else {
                console.warn(`[${now}] Необычный ответ сервера (статус: ${resp.statusCode})`);
            }
        }).on('error', (err) => {
            console.error(`[${now}] Ошибка при пинге сервера:`, err.message);
        });
    }

    // Запускаем пинг сразу
    ping();

    // Устанавливаем интервал
    const interval = setInterval(ping, INTERVAL);

    // Добавляем обработчик для очистки интервала при завершении работы
    process.on('SIGTERM', () => {
        clearInterval(interval);
        console.log('Интервал поддержания сервера остановлен');
    });

    return interval;
}

app.listen(port, () => {
    console.log(`Сервер запущен на порту ${port}`);
    console.log('Версия Node.js:', process.version);
    console.log('Платформа:', process.platform);
    initializeCache();
    keepAlive();
    setupSchedule(); // Запускаем планировщик
});