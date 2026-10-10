from flask import Flask, request, Response
import time
import random
import json
import re

app = Flask(__name__)

# --- Конфигурация защиты ---
# Настройте эти параметры под ваши нужды
ALLOWED_USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.88 Safari/537.36'
]
MAX_REQUESTS_PER_IP = 5  # Максимальное количество запросов с одного IP в секунду
REQUEST_HISTORY = {} # Хранилище для отслеживания запросов

@app.before_request
def check_user_agent():
    """Уровень 1: Проверка User-Agent."""
    user_agent = request.headers.get('User-Agent', '')
    
    # Проверка на известные боты/скрипты
    if not any(ua in user_agent for ua in ALLOWED_USER_AGENTS):
        # Возвращаем ошибку 403, чтобы боты не видели контент
        return Response("Detected automated bot. Access denied.", status=403)
    
    # Уровень 2: Проверка скорости запросов (очень базовая)
    ip_address = request.remote_addr
    current_time = time.time()
    
    if ip_address not in REQUEST_HISTORY:
        REQUEST_HISTORY[ip_address] = {'count': 0, 'last_reset': current_time}
    
    # Сброс счетчика, если прошло более 1 секунды
    if current_time - REQUEST_HISTORY[ip_address]['last_reset'] > 1.0:
        REQUEST_HISTORY[ip_address]['count'] = 0
        REQUEST_HISTORY[ip_address]['last_reset'] = current_time
    
    REQUEST_HISTORY[ip_address]['count'] += 1
    
    if REQUEST_HISTORY[ip_address]['count'] > MAX_REQUESTS_PER_IP:
        return Response("Too many requests. Please slow down.", status=429)

# --- Основные маршруты ---

@app.route('/')
def index():
    """Основная страница, которая возвращает контент."""
    # Здесь вы размещаете ваш основной контент
    html_content = """
    <html>
        <head><title>Защищенный Сайт</title></head>
        <body>
            <h1>Добро пожаловать на защищенный сайт!</h1>
            <p>Этот контент доступен реальным пользователям.</p>
            <p>Если вы видите это, значит, проверка прошла успешно.</p>
        </body>
    </html>
    """
    return Response(html_content, mimetype='text/html')

@app.route('/protected_page')
def protected_page():
    """Страница, которая требует JS-выполнения (Уровень 3)."""
    # В реальном приложении здесь вы бы возвращали HTML, который содержит JS.
    # Для демонстрации, мы просто возвращаем HTML, предполагая, что JS в нем.
    js_content = """
    <script>
        console.log("JavaScript executed successfully!");
        // Здесь может быть сложная логика, которая должна пройти только в реальном браузере.
    </script>
    <html>
        <head><title>JS Test</title></head>
        <body>
            <h1>JavaScript Test Page</h1>
            <p>Если вы видите это, значит, браузер выполнил скрипт.</p>
        </body>
    </html>
    """
    return Response(js_content, mimetype='text/html')


if __name__ == '__main__':
    # Запуск сервера
    print("Сервер запущен. Для доступа используйте http://127.0.0.1:5000/")
    app.run(debug=True, host='0.0.0.0', port=5000)