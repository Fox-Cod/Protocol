# Как запустить и собрать

## Требования
- [Node.js](https://nodejs.org/) (LTS-версия)

## Запуск в режиме разработки
```bash
cd app
npm install
npm start
```

## Сборка .exe
```bash
npm run dist
```
Готовый `Protocol.exe` появится в папке `dist/`.

> Если иконка .exe не обновилась — очисти кэш:
> удали папку `dist/` и `%LOCALAPPDATA%\electron-builder\Cache`, затем собери заново.

## Файлы
- `main.js` — процесс Electron (окно, стикеры, горячие клавиши)
- `preload.js` — мост между окном и системой
- `GovHelper.html` — само приложение (собранное, React внутри)
- `GovHelper.jsx` — исходник React (мастер-файл для правок)
- `sticker.html` — окно заметки-стикера
- `package.json` — конфигурация и сборка
- `icon.ico` / `icon.png` — иконки приложения
