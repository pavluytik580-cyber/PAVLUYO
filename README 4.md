# PAVLUYO — final v6

Финальная версия PAVLUYO: 1–11 классы, предметы, темы, динамические задания, объяснение ошибок, «Победи себя», аватар, XP, медали, Premium 99 ₽/30 дней и серверный счётчик активных сессий.

## Важно про Premium

Автоматическая разблокировка после реальной оплаты требует подключения интернет-эквайринга/СБП Т‑Банка. В проекте уже подготовлены серверные endpoints:

- `POST /api/payment/create`
- `GET /api/payment/status`
- `POST /api/payment/webhook`
- `POST /api/presence/heartbeat`
- `GET /api/presence/stats`

Для настоящих платежей нужно добавить секреты/ключи Т‑Банка в Cloudflare Worker Secrets и настроить webhook в Т‑Бизнесе. Не помещайте секретные ключи в `index.html`.

Переменные Worker Secrets:

- `TBANK_API_TOKEN`
- `TBANK_TERMINAL_KEY`
- `TBANK_NOTIFICATION_PASSWORD`

После подключения T‑Bank API сайт создаёт отдельный заказ на 99 ₽, ждёт подтверждение банка и только после подтверждения включает Premium на 30 дней.

## Онлайн

Счётчик использует Cloudflare Durable Object и heartbeat активных браузерных сессий. «Онлайн» — активные сессии с heartbeat за последние ~20 секунд; «учатся» — активные сессии, находящиеся в учебном процессе за последние ~60 секунд. Это не искусственное число.

## Деплой

Проект рассчитан на Cloudflare Workers Builds. `wrangler.jsonc` уже содержит Worker, Assets и Durable Object SQLite migration.
