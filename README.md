# Fleet API Server

Сервер для получения данных о топе курьеров из Google Sheets.

## Установка

1. Клонируйте репозиторий
2. Установите зависимости:
```bash
npm install
```

## Настройка Google Sheets API

1. Перейдите в [Google Cloud Console](https://console.cloud.google.com/)
2. Создайте новый проект
3. Включите Google Sheets API
4. Создайте Service Account и скачайте ключ в формате JSON
5. Скопируйте `client_email` и `private_key` из JSON файла
6. Вставьте эти данные в файл `.env`
7. Предоставьте доступ к вашей таблице для email сервисного аккаунта

## Запуск

```bash
npm start
```

## Эндпоинты

### GET /top/money/today
Возвращает топ курьеров за сегодня

### GET /top/money/yesterday
Возвращает топ курьеров за вчера

## Формат ответа

```json
[
  {
    "rank": "1",
    "phone": "T79.13112",
    "orders": "4",
    "hours": "1.8",
    "money": "2700",
    "moneyPerHour": "1486"
  }
]
``` 