# FitPass booking

Готовая Express-приложение для размещения на Vercel. Vercel поддерживает Express с zero-configuration.

## Что настроить в Vercel

В Project Settings → Environment Variables добавьте:

- `ADMIN_USER` — логин менеджера
- `ADMIN_PASS` — сильный пароль менеджера
- `SESSION_SECRET` — длинная случайная строка

Для production `ADMIN_PASS` не имеет безопасного значения по умолчанию.

## GitHub → Vercel

1. Распакуйте ZIP.
2. Загрузите содержимое в новый GitHub repository.
3. В Vercel выберите **Add New → Project** и импортируйте repository.
4. Framework Preset можно оставить `Other`; Vercel определяет Express.
5. Добавьте три переменные выше.
6. Deploy.

Официальная документация Vercel подтверждает zero-configuration deployment для Express: https://vercel.com/kb/express

## Локальный запуск

```bash
npm install
npm start
```

После этого откройте http://localhost:3000

## Важно про хранение заявок

Текущая версия использует `data.json` как простое файловое хранилище. Это подходит для локального теста, но для постоянной работы на Vercel лучше подключить внешнюю базу данных: файловая система serverless/Fluid Compute не должна рассматриваться как постоянная БД.

`data.json` в исходном ZIP пустой и не содержит данных клиентов.
