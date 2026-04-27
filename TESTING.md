# Инструкция по тестированию Python WASM

## 1. Тест прямо сейчас — редактор с Pyodide

Открой `editor/index.html` в браузере. Это реальный CPython 3.12 в WASM (через Pyodide).

```bash
# Вариант 1: через любой локальный сервер
npx serve editor/

# Вариант 2: Python
python -m http.server 8080 --directory editor/

# Вариант 3: VS Code Live Server — открой editor/index.html → Right Click → Open with Live Server
```

Затем открой http://localhost:8080 в браузере.

> ⚠️ Нужен HTTP-сервер (не file://), иначе Pyodide не загрузится из-за CORS.

---

## 2. Сборка нашего CPython WASM через GitHub Actions

### Шаг 1 — Запушить код

```bash
git add .
git commit -m "feat: add CPython WASM build workflow"
git push -u origin main
```

### Шаг 2 — Запустить сборку

1. Открой https://github.com/Bebrazui/PyWasmBuilds
2. Перейди в **Actions** → **Build CPython WASM (wasm32-wasi)**
3. Нажми **Run workflow** → **Run workflow**
4. Жди ~30-40 минут

### Шаг 3 — Скачать артефакт

После успешной сборки:
1. Открой завершённый workflow run
2. Внизу страницы найди **Artifacts**
3. Скачай `cpython-wasm-wasi.zip`
4. Распакуй — внутри будет `python.wasm` и `python313-stdlib.zip`

### Шаг 4 — Подключить наш WASM к редактору

Положи `python.wasm` в папку `editor/`:

```
editor/
├── index.html
└── python.wasm   ← сюда
```

Затем в `editor/index.html` замени строку с Pyodide на наш runtime:

```html
<!-- Убери это: -->
<script src="https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js"></script>

<!-- Добавь это: -->
<script type="module">
  import { PythonRuntime } from '../dist/index.js';

  const runtime = new PythonRuntime();
  await runtime.init({ wasmUrl: './python.wasm' });

  runtime.onStdout = (text) => appendOutput(text, 'stdout');
  runtime.onStderr = (text) => appendOutput(text, 'stderr');

  window.pyodide = {
    runPython: (code) => runtime.run(code),
    runPythonAsync: (code) => runtime.run(code),
  };
</script>
```

---

## 3. Запуск unit-тестов

```bash
npm run test
```

Ожидаемый результат: **29 passed**

---

## 4. Что проверяет каждый тест

| Тест | Что проверяет |
|------|---------------|
| WASIShim (16 тестов) | WASI syscalls, interrupt, whitelist, fd routing |
| VFS structure | Предустановленные директории |
| VFS round-trip | writeFile → readFile |
| VFS FileNotFoundError | Ошибка для несуществующих файлов |
| ConfigParser defaults | Дефолтные значения конфига |
| ConfigParser validation | Ошибка при неверном типе поля |
| ConfigParser unknown fields | Игнорирование неизвестных полей |
| Serializer round-trip | JS → Python → JS сериализация |
| Serializer depth limit | Ошибка при глубине > 100 |
| NoPersistenceBackend | No-op бэкенд работает без ошибок |
| PythonRuntime mock | Инициализация с mock WASM |

---

## 5. Структура проекта

```
src/
├── index.ts              ← публичный API: import { PythonRuntime } from './src'
├── proxy/RuntimeProxy.ts ← main-thread API
├── worker/
│   ├── PythonRuntime.ts  ← CPython WASM runtime (внутри Worker)
│   ├── WorkerEntrypoint.ts
│   ├── WASMExtensionLoader.ts ← C-extensions (numpy и т.д.)
│   └── importHook.py     ← Python import hook
├── wasi/WASIShim.ts      ← WASI Preview 1 syscalls
├── vfs/VirtualFileSystem.ts
├── persistence/          ← OPFS / IndexedDB / None
├── pip/PipManager.ts
├── serializer/Serializer.ts
├── config/ConfigParser.ts
└── errors/index.ts

editor/
└── index.html            ← редактор (сейчас на Pyodide, потом наш WASM)

.github/workflows/
└── build-cpython-wasm.yml ← GitHub Actions сборка
```
