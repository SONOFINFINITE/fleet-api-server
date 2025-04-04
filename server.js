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
        dailyBonuSum: null,
        lastUpdate: 0
    },
    yesterday: {
        data: null,
        dailyBonuSum: null,
        lastUpdate: 0
    },
    week: {
        data: null,
        weeklyBonusSum: null,
        lastUpdate: 0
    },
    month: {
        data: null,
        monthlyBonus: null,
        lastUpdate: 0
    },
    lastweek: {
        data: null,
        weeklyBonusSum: null,
        lastUpdate: 0
    },
    lastmonth: {
        data: null,
        monthlyBonus: null,
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
const spreadsheetId = '1ZzEEPB5tCp2hmKQJmDDhLl_Od6lG5bO_NyQGQrBDdrw';

// Функция для получения данных из таблицы
async function getSheetData(ranges, sheetName, type) {
    try {
        console.log(`Получение данных из таблицы. Диапазоны: ${ranges.join(', ')}, Лист: ${sheetName}`);
        
        // Получаем данные из всех диапазонов
        const [topData, bonusData] = await Promise.all([
            sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `'${sheetName}'!${ranges[0]}`
            }),
            sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `'${sheetName}'!${ranges[1]}`
            })
        ]);

        console.log(`Получено строк: ${topData.data.values?.length || 0}`);
        console.log(`Получен бонус:`, bonusData.data.values?.[0]?.[0]);

        const rows = topData.data.values || [];
        const bonusSum = bonusData.data.values?.[0]?.[0] || '0';

        return {
            topList: rows.map(row => ({
                rank: row[0] || '',
                phone: row[1] || '',
                orders: row[5] || '',
                hours: row[6] || '',
                money: row[9] || '',
                moneyPerHour: row[8] || ''
            })),
            ...(type === 'week' || type === 'lastweek' ? { weeklyBonusSum: bonusSum } : { dailyBonuSum: bonusSum })
        };
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
    if (!cacheEntry.data || !(type === 'week' || type === 'lastweek' ? cacheEntry.weeklyBonusSum : type === 'month' || type === 'lastmonth' ? cacheEntry.monthlyBonus : cacheEntry.dailyBonuSum) || now - cacheEntry.lastUpdate > CACHE_TTL) {
        try {
            const sheetName = type === 'today' ? 'выводДеньДеньги (СЕГОДНЯ)' : 
                             type === 'yesterday' ? 'выводДеньДеньги (ВЧЕРА)' : 
                             type === 'week' ? 'выводДеньгиПер (НЕДЕЛЯ)' :
                             type === 'month' ? 'выводДеньгиПер (МЕСЯЦ)' :
                             type === 'lastweek' ? 'выводДеньгиПер (ПРОШЛАЯ НЕДЕЛЯ)' :
                             'выводДеньгиПер (ПРОШЛЫЙ МЕСЯЦ)';
            
            const ranges = type === 'week' || type === 'lastweek' ? 
                          ['C19:L28', 'F8'] : 
                          type === 'month' || type === 'lastmonth' ?
                          ['C19:L28', 'L8'] :
                          ['C20:L29', 'F8'];

            const result = await getSheetData(ranges, sheetName, type);
            cacheEntry.data = result.topList;
            if (type === 'week' || type === 'lastweek') {
                cacheEntry.weeklyBonusSum = result.weeklyBonusSum;
            } else if (type === 'month' || type === 'lastmonth') {
                cacheEntry.monthlyBonus = result.dailyBonuSum; // Используем dailyBonuSum для хранения месячного бонуса
            } else {
                cacheEntry.dailyBonuSum = result.dailyBonuSum;
            }
            cacheEntry.lastUpdate = now;
            console.log(`Кэш обновлен для ${type} в ${new Date().toLocaleTimeString()}`);
        } catch (error) {
            console.error(`Ошибка обновления кеша для ${type}:`, error);
            if (cacheEntry.data && (type === 'week' || type === 'lastweek' ? cacheEntry.weeklyBonusSum : type === 'month' || type === 'lastmonth' ? cacheEntry.monthlyBonus : cacheEntry.dailyBonuSum)) {
                console.warn(`Используем старые данные для ${type}`);
            } else {
                throw error;
            }
        }
    }

    return {
        topList: cacheEntry.data,
        ...(type === 'week' || type === 'lastweek' ? { weeklyBonusSum: cacheEntry.weeklyBonusSum } : 
           type === 'month' || type === 'lastmonth' ? { monthlyBonus: cacheEntry.monthlyBonus } :
           { dailyBonuSum: cacheEntry.dailyBonuSum })
    };
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

// Эндпоинт для получения данных за неделю
app.get('/top/money/week', async (req, res) => {
    try {
        const data = await getCachedData('week');
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Эндпоинт для получения данных за месяц
app.get('/top/money/month', async (req, res) => {
    try {
        const data = await getCachedData('month');
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Эндпоинт для получения данных за прошлую неделю
app.get('/top/money/lastweek', async (req, res) => {
    try {
        const data = await getCachedData('lastweek');
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Эндпоинт для получения данных за прошлый месяц
app.get('/top/money/lastmonth', async (req, res) => {
    try {
        const data = await getCachedData('lastmonth');
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Эндпоинт для получения месячного бонуса
app.get('/monthlybonus', async (req, res) => {
    try {
        const cacheEntry = cache.month;
        const now = Date.now();

        // Проверяем, нужно ли обновить кеш
        if (!cacheEntry.monthlyBonus || now - cacheEntry.lastUpdate > CACHE_TTL) {
            try {
                const response = await sheets.spreadsheets.values.get({
                    spreadsheetId,
                    range: `'выводДеньгиПер (МЕСЯЦ)'!L8`
                });

                cacheEntry.monthlyBonus = response.data.values?.[0]?.[0] || '0';
                cacheEntry.lastUpdate = now;
                console.log(`Месячный бонус обновлен: ${cacheEntry.monthlyBonus}`);
            } catch (error) {
                console.error('Ошибка при получении месячного бонуса:', error);
                if (cacheEntry.monthlyBonus) {
                    console.warn('Используем старое значение месячного бонуса');
                } else {
                    throw error;
                }
            }
        }

        res.json({
            monthlyBonus: cacheEntry.monthlyBonus
        });
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
            getCachedData('yesterday'),
            getCachedData('week'),
            getCachedData('month'),
            getCachedData('lastweek'),
            getCachedData('lastmonth'),
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
async function runSummaryUpdateScript() {
    try {
        const scriptUrl = process.env.GOOGLE_SCRIPT_URL;
        const startTime = Date.now();
        
        if (!scriptUrl) {
            throw new Error('URL скрипта не настроен');
        }

        const scriptPromise = new Promise((resolve, reject) => {
            const req = https.get(scriptUrl, (response) => {
                if (response.statusCode !== 200 && response.statusCode !== 302) {
                    reject(new Error(`Ошибка запуска скрипта: ${response.statusCode}`));
                    return;
                }

                let data = '';
                response.on('data', (chunk) => {
                    data += chunk;
                });

                response.on('end', () => {
                    console.log('Ответ от скрипта:', data);
                    const executionTime = Date.now() - startTime;
                    const isFastExecution = executionTime < 60000;
                    resolve({ 
                        status: 'success', 
                        message: 'Скрипт успешно выполнен' + (isFastExecution ? ' SPEED_DEMON' : '')
                    });
                });
            });

            // Устанавливаем таймаут в 3 минуты
            req.setTimeout(180000, () => {
                req.destroy();
                reject(new Error('Превышено время ожидания ответа от скрипта (3 минуты)'));
            });

            req.on('error', (err) => {
                console.error('Ошибка сетевого запроса:', err);
                reject(err);
            });
        });

        const result = await scriptPromise;
        console.log(`Скрипт успешно выполнен в ${new Date().toLocaleTimeString()}`);
        return result;
    } catch (error) {
        console.error('Ошибка при запуске скрипта:', error);
        return { status: 'error', message: error.message };
    }
}

async function runYesterdayBonusScript() {
    try {
        const scriptUrl = process.env.GOOGLE_SCRIPT_URL;
        
        if (!scriptUrl) {
            throw new Error('URL скрипта не настроен');
        }

        const urlWithParams = `${scriptUrl}?operation=updateBonus`;
        console.log('Запуск скрипта обновления бонусов:', urlWithParams);

        const scriptPromise = new Promise((resolve, reject) => {
            const req = https.get(urlWithParams, (response) => {
                if (response.statusCode !== 200 && response.statusCode !== 302) {
                    reject(new Error(`Ошибка запуска скрипта: ${response.statusCode}`));
                    return;
                }

                let data = '';
                response.on('data', (chunk) => {
                    data += chunk;
                });

                response.on('end', () => {
                    console.log('Ответ от скрипта обновления бонусов:', data);
                    // Резолвим промис только после получения всех данных
                    resolve({ status: 'success', message: 'Скрипт обновления бонусов успешно выполнен', data });
                });
            });

            // Устанавливаем таймаут в 3 минуты
            req.setTimeout(180000, () => {
                req.destroy();
                reject(new Error('Превышено время ожидания ответа от скрипта (3 минуты)'));
            });

            req.on('error', (err) => {
                console.error('Ошибка сетевого запроса:', err);
                reject(err);
            });
        });

        const result = await scriptPromise;
        console.log(`Скрипт обновления бонусов успешно выполнен в ${new Date().toLocaleTimeString()}`);
        return result;
    } catch (error) {
        console.error('Ошибка при запуске скрипта обновления бонусов:', error);
        return { status: 'error', message: error.message };
    }
}

// Эндпоинт для запуска Google Apps Script функции
app.get('/runTransactionsForCurrentDate', async (req, res) => {
    try {
        const result = await runSummaryUpdateScript();
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

app.get('/updatePreviousDayCashlessWithBonuses', async (req, res) => {
    try {
        const result = await runYesterdayBonusScript();
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

// Инициализация кеша при запуске сервера
async function initializeCache() {
    try {
        await getCachedData('today');
        await getCachedData('yesterday');
        await getCachedData('week');
        await getCachedData('month');
        await getCachedData('lastweek');
        await getCachedData('lastmonth');
        console.log('Кеш успешно инициализирован');
    } catch (error) {
        console.error('Ошибка при инициализации кеша:', error);
    }
}

// Функция для поддержания сервера активным
function keepAlive() {
    const INTERVAL = 2 * 60 * 1000; // 2 минуты
    
    async function ping() {
        const now = new Date().toLocaleTimeString();
        console.log(`[${now}] Поддержание сервера активным...`);

        try {
            // Обновляем кэш
            await Promise.all([
                getCachedData('today'),
                getCachedData('yesterday'),
                getCachedData('week'),
                getCachedData('month'),
                getCachedData('lastweek'),
                getCachedData('lastmonth')
            ]);
            console.log(`[${now}] Кэш успешно обновлен`);
        } catch (error) {
            console.error(`[${now}] Ошибка при обновлении кэша:`, error);
        }

        // Если мы на Render, делаем внешний запрос к нашему приложению
        if (process.env.RENDER_EXTERNAL_URL) {
            try {
                const url = `${process.env.RENDER_EXTERNAL_URL}/status`;
                const pingPromise = new Promise((resolve, reject) => {
                    const req = https.get(url, (res) => {
                        let data = '';
                        res.on('data', (chunk) => { data += chunk; });
                        res.on('end', () => {
                            if (res.statusCode === 200) {
                                console.log(`[${now}] Внешний пинг успешен (${res.statusCode})`);
                                resolve(data);
                            } else {
                                reject(new Error(`Неожиданный статус: ${res.statusCode}`));
                            }
                        });
                    });

                    req.on('error', reject);
                    req.setTimeout(5000, () => {
                        req.destroy();
                        reject(new Error('Таймаут запроса'));
                    });

                    req.end();
                });

                await pingPromise;
            } catch (error) {
                console.error(`[${now}] Ошибка внешнего пинга:`, error.message);
            }
        }
    }

    // Запускаем пинг сразу
    ping().catch(console.error);

    // Устанавливаем интервал
    return setInterval(() => {
        ping().catch(console.error);
    }, INTERVAL);
}

app.listen(port, () => {
    console.log(`Сервер запущен на порту ${port}`);
    console.log('Версия Node.js:', process.version);
    console.log('Платформа:', process.platform);
    initializeCache();
    keepAlive();
});