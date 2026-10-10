import os
from flask import Flask, request, render_template_string, abort
import re

app = Flask(__name__)

# --- Конфигурация ---
# Расширенный список User-Agents и паттернов, которые мы хотим заблокировать
BLOCKED_PATTERNS = [
    "bot",
    "spider",
    "crawler",
    "Scrapy",
    "Googlebot",
    "Bingbot",
    "AhrefsBot",
    "SemrushBot"
]

# Паттерны, которые часто встречаются в автоматических запросах (например, отсутствие некоторых стандартных заголовков)
# В реальной жизни это сложнее, но для примера мы проверяем наличие "Referer" или "Accept-Language"
SUSPICIOUS_HEADERS = [
    "python-urllib",  # Часто встречается в скриптах
    "curl",           # Часто встречается в скриптах
    "headless"        # Указывает на headless-браузер
]

# --- Шаблоны ---
SUCCESS_PAGE = """
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Добро пожаловать!</title>
</head>
<body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px;">
    <h1 style="color: #28a745;">✅ Добро пожаловать!</h1>
    <p>Вы успешно прошли проверку. Это контент для реальных посетителей.</p>
    <p>Ваш User-Agent: {{ user_agent }}</p>
</body>
</html>
"""

BOT_ERROR_PAGE = """
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ошибка доступа</title>
</head>
<body style="font-family: Arial, sans-serif; text-align: center; padding-top: 50px; color: #dc3545;">
    <h1 style="color: #dc3545;">🚫 Доступ запрещен</h1>
    <p>Ваш запрос был идентифицирован как автоматический или сканер. Пожалуйста, используйте обычный браузер для просмотра.</p>
</body>
</html>
"""

def is_bot(request):
    """Многоуровневая проверка, чтобы определить, является ли запрос ботом/сканером."""
    user_agent = request.headers.get('User-Agent', '')
    
    # 1. Проверка на User-Agent
    ua_lower = user_agent.lower()
    for pattern in BLOCKED_PATTERNS:
        if pattern.lower() in ua_lower:
            print(f"Блокировка по User-Agent: {user_agent}")
            return True
            
    # 2. Проверка на подозрительные заголовки (более тонкая проверка)
    for header in SUSPICIOUS_HEADERS:
        if header in user_agent.lower():
            print(f"Блокировка по подозрительному заголовку: {header}")
            return True

    # 3. Дополнительная проверка (если нужно, можно добавить проверку на отсутствие JS или специфические пути)
    # Для простоты, пока оставим только User-Agent и заголовки.

    return False

@app.route('/', methods=['GET'])
def index():
    """Главная страница. Проверяет User-Agent."""
    if is_bot(request):
        # Если это бот/сканер, показываем ошибку
        return render_template_string(BOT_ERROR_PAGE)
    else:
        # Если это реальный пользователь, показываем основной контент
        return render_template_string(SUCCESS_PAGE, user_agent=request.headers.get('User-Agent', 'N/A'))

@app.errorhandler(404)
def page_not_found(e):
    """Обработчик ошибки 404."""
    return render_template_string(BOT_ERROR_PAGE, title="404 Not Found")

if __name__ == '__main__':
    # Запуск сервера на порту 5000
    app.run(debug=True, host='0.0.0.0', port=5000)