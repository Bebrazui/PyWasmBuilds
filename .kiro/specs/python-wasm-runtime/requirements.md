# Requirements Document

## Introduction

Кастомный Python WASM Runtime — это полноценная среда выполнения Python в браузере, построенная поверх CPython, скомпилированного в WebAssembly через wasi-sdk (wasm32-wasi target). Это **не** обёртка над Pyodide и не использует Emscripten. Вместо этого — собственный слой поверх чистого CPython + WASI, обеспечивающий:

- Полную виртуальную файловую систему (Python «думает», что работает в обычной Linux-среде)
- Поддержку C-extensions (numpy, pandas и другие тяжёлые пакеты через pre-compiled WASM wheels)
- Установку пакетов через pip, включая пакеты с нативными расширениями
- Полную изоляцию: каждый экземпляр Runtime — отдельная WASM-песочница
- Персистентность VFS через OPFS (Origin Private File System) или IndexedDB
- Выполнение в Web Worker без блокировки UI
- Полную стандартную библиотеку Python

---

## Glossary

- **Runtime** — экземпляр Python-среды выполнения, запущенный в браузере через WASM. Каждый экземпляр — отдельная WASM-песочница.
- **CPython** — эталонная реализация интерпретатора Python, скомпилированная под wasm32-wasi target через wasi-sdk.
- **WASI (WebAssembly System Interface)** — стандартный системный интерфейс для WASM-модулей, обеспечивающий доступ к файловой системе, сокетам и другим системным ресурсам.
- **wasi-sdk** — набор инструментов (clang + sysroot) для компиляции C/C++ кода в wasm32-wasi.
- **VFS (Virtual File System)** — виртуальная файловая система, реализованная поверх WASI, которую Python воспринимает как обычную Linux FS.
- **OPFS (Origin Private File System)** — браузерный API для персистентного хранения файлов, привязанного к origin.
- **WASM Wheel** — Python-пакет в формате wheel, содержащий C-extensions, скомпилированные под wasm32-wasi.
- **Worker** — Web Worker, в котором изолированно выполняется Runtime, чтобы не блокировать главный поток браузера.
- **Host** — браузерная страница (главный поток), взаимодействующая с Runtime через Worker API.
- **WASI Shim** — JavaScript-слой, реализующий WASI-интерфейс поверх браузерных API (File System Access API, OPFS, fetch и т.д.).
- **Package** — Python-пакет, устанавливаемый из PyPI или локального источника, включая пакеты с C-extensions в виде WASM wheels.
- **Snapshot** — сериализованное состояние VFS, сохраняемое в OPFS или IndexedDB.
- **Stderr / Stdout** — стандартные потоки вывода Python-процесса, перехватываемые через WASI.
- **Sandbox** — изолированное WASM-окружение, в котором выполняется один экземпляр Runtime.

---

## Requirements

### Requirement 1: Компиляция и загрузка CPython WASM модуля

**User Story:** Как разработчик, я хочу загружать CPython, скомпилированный под wasm32-wasi, в браузере, чтобы получить нативный Python-интерпретатор без зависимости от Pyodide или Emscripten.

#### Acceptance Criteria

1. THE Runtime SHALL загружать CPython WASM-модуль (`.wasm` бинарник, скомпилированный через wasi-sdk под wasm32-wasi target) из CDN или локального бандла при вызове `Runtime.init()`.
2. WHEN загрузка WASM-модуля завершена и WASI Shim инициализирован, THE Runtime SHALL сообщать о готовности через resolved Promise.
3. IF загрузка WASM-модуля завершается ошибкой сети, THEN THE Runtime SHALL отклонять Promise с описательным сообщением об ошибке, включающим HTTP-статус и URL.
4. THE Runtime SHALL инициализироваться в отдельном Web Worker, чтобы не блокировать главный поток браузера.
5. WHEN Runtime уже инициализирован в текущем Worker, THE Runtime SHALL возвращать существующий экземпляр без повторной загрузки WASM-модуля.
6. THE Runtime SHALL поддерживать потоковую компиляцию WASM через `WebAssembly.instantiateStreaming()` для уменьшения времени инициализации.
7. THE Runtime SHALL монтировать стандартную библиотеку Python (stdlib) в VFS по пути `/usr/lib/python3.x/` при инициализации.

---

### Requirement 2: WASI Shim — реализация системного интерфейса

**User Story:** Как разработчик, я хочу, чтобы CPython мог вызывать системные функции (файловый ввод-вывод, время, случайные числа) через WASI-интерфейс, реализованный поверх браузерных API.

#### Acceptance Criteria

1. THE WASI_Shim SHALL реализовывать полный набор WASI Preview 1 syscalls, необходимых для работы CPython: `fd_read`, `fd_write`, `fd_seek`, `fd_close`, `path_open`, `path_create_directory`, `path_remove_directory`, `path_unlink_file`, `path_rename`, `path_stat`, `clock_time_get`, `random_get`.
2. WHEN CPython вызывает `fd_write` для файлового дескриптора stdout (fd=1), THE WASI_Shim SHALL перехватывать вывод и передавать его в callback `onStdout` без буферизации строк длиннее 4096 байт.
3. WHEN CPython вызывает `fd_write` для файлового дескриптора stderr (fd=2), THE WASI_Shim SHALL перехватывать вывод и передавать его в callback `onStderr`.
4. THE WASI_Shim SHALL реализовывать `clock_time_get` через `performance.now()` и `Date.now()` для обеспечения работы модулей `time` и `datetime`.
5. THE WASI_Shim SHALL реализовывать `random_get` через `crypto.getRandomValues()` для обеспечения криптографически стойкой случайности.
6. IF CPython вызывает WASI syscall, не реализованный в WASI_Shim, THEN THE WASI_Shim SHALL возвращать код ошибки `ENOSYS` и логировать предупреждение в консоль браузера.

---

### Requirement 3: Виртуальная файловая система (VFS)

**User Story:** Как разработчик, я хочу, чтобы Python-код мог читать и писать файлы через стандартные модули `os`, `pathlib` и `open()`, воспринимая VFS как обычную Linux-файловую систему.

#### Acceptance Criteria

1. THE VFS SHALL предоставлять иерархическую файловую систему с корневым каталогом `/`, поддерживающую пути в стиле POSIX.
2. WHEN Python-код вызывает `open(path, 'r')`, THE VFS SHALL возвращать файловый объект, читающий данные из in-memory хранилища VFS через WASI syscalls.
3. WHEN Python-код вызывает `open(path, 'w')`, THE VFS SHALL создавать или перезаписывать файл в in-memory хранилище VFS.
4. THE VFS SHALL поддерживать стандартные операции: создание файлов, чтение, запись, удаление, переименование, создание директорий (включая рекурсивное), листинг директорий, получение метаданных (`stat`).
5. THE VFS SHALL предоставлять предустановленную структуру директорий при инициализации: `/home/user/`, `/tmp/`, `/usr/lib/python3.x/`, `/usr/local/lib/python3.x/site-packages/`.
6. WHEN метод `Runtime.fs.writeFile(path: string, content: Uint8Array | string)` вызван из Host, THE VFS SHALL записать файл по указанному пути в VFS.
7. WHEN метод `Runtime.fs.readFile(path: string)` вызван из Host, THE VFS SHALL вернуть содержимое файла как `Uint8Array`.
8. IF файл по указанному пути не существует при вызове `Runtime.fs.readFile()`, THEN THE VFS SHALL отклонять Promise с ошибкой `FileNotFoundError`, содержащей путь к файлу.
9. WHEN метод `Runtime.fs.listDir(path: string)` вызван, THE VFS SHALL возвращать массив объектов `{ name: string, isDirectory: boolean, size: number }`.
10. THE VFS SHALL изолировать файловую систему каждого экземпляра Runtime: файлы одного экземпляра недоступны другому экземпляру.

---

### Requirement 4: Персистентность VFS через OPFS и IndexedDB

**User Story:** Как пользователь, я хочу, чтобы файлы, созданные в Runtime, сохранялись между сессиями браузера, чтобы не терять результаты работы при перезагрузке страницы.

#### Acceptance Criteria

1. WHERE OPFS доступен в браузере, THE Runtime SHALL использовать Origin Private File System как основной бэкенд для персистентности VFS.
2. WHERE OPFS недоступен, THE Runtime SHALL использовать IndexedDB как резервный бэкенд для персистентности VFS.
3. THE Runtime SHALL монтировать персистентную директорию `/home/user/` и синхронизировать её с выбранным бэкендом персистентности.
4. WHEN метод `Runtime.fs.sync()` вызван, THE Runtime SHALL сохранять изменённые файлы из in-memory VFS в OPFS или IndexedDB и возвращать resolved Promise после завершения записи.
5. WHEN Runtime инициализируется повторно для того же origin, THE Runtime SHALL восстанавливать содержимое `/home/user/` из OPFS или IndexedDB.
6. IF OPFS и IndexedDB недоступны (например, в приватном режиме браузера), THEN THE Runtime SHALL инициализироваться в режиме без персистентности и уведомлять об этом через событие `onWarning` с кодом `PERSISTENCE_UNAVAILABLE`.
7. WHEN метод `Runtime.fs.clearPersistent()` вызван, THE Runtime SHALL удалять все персистентные данные для текущего origin и возвращать resolved Promise.
8. THE Runtime SHALL поддерживать автоматическую синхронизацию VFS с персистентным бэкендом с интервалом, настраиваемым через параметр `autoSyncInterval` (в миллисекундах, 0 — отключить).

---

### Requirement 5: Поддержка C-extensions через WASM Wheels

**User Story:** Как разработчик, я хочу устанавливать Python-пакеты с C-extensions (numpy, pandas, scipy и другие), скомпилированными под wasm32-wasi, чтобы использовать тяжёлые научные библиотеки в браузере.

#### Acceptance Criteria

1. THE Runtime SHALL поддерживать загрузку и установку WASM Wheels — Python-пакетов в формате wheel, содержащих C-extensions, скомпилированные под wasm32-wasi target.
2. WHEN WASM Wheel загружен, THE Runtime SHALL распаковывать wheel-архив в VFS по пути `/usr/local/lib/python3.x/site-packages/` и регистрировать `.so`-файлы (WASM-бинарники) как динамически загружаемые модули.
3. THE Runtime SHALL поддерживать динамическую загрузку WASM-модулей C-extensions через кастомный import hook, перехватывающий `import` для `.so`-файлов.
4. WHEN Python-код выполняет `import numpy`, THE Runtime SHALL загружать соответствующий WASM-модуль C-extension и связывать его с CPython через Python C API.
5. THE Runtime SHALL предоставлять реестр pre-compiled WASM Wheels для популярных пакетов: numpy, pandas, scipy, pillow, cryptography.
6. IF запрошенный пакет отсутствует в реестре WASM Wheels и не имеет pure-Python fallback, THEN THE Runtime SHALL отклонять установку с ошибкой `NoWASMWheelError`, содержащей имя пакета и ссылку на реестр.

---

### Requirement 6: Установка пакетов через pip

**User Story:** Как разработчик, я хочу устанавливать Python-пакеты из PyPI прямо в браузере, включая пакеты с C-extensions, чтобы использовать сторонние библиотеки в Runtime.

#### Acceptance Criteria

1. WHEN метод `Runtime.pip.install(packageName: string)` вызван, THE Runtime SHALL устанавливать пакет, выбирая WASM Wheel из реестра (для пакетов с C-extensions) или pure-Python wheel с PyPI.
2. WHEN установка пакета завершена, THE Runtime SHALL возвращать resolved Promise с объектом `{ name: string, version: string, source: 'wasm-registry' | 'pypi' }`.
3. IF пакет не найден ни в реестре WASM Wheels, ни на PyPI, THEN THE Runtime SHALL отклонять Promise с ошибкой `PackageNotFoundError`, содержащей имя пакета.
4. IF пакет на PyPI содержит только C-extension wheels для платформ, отличных от wasm32-wasi, и отсутствует в реестре WASM Wheels, THEN THE Runtime SHALL отклонять Promise с ошибкой `IncompatiblePackageError` с описанием причины.
5. WHEN метод `Runtime.pip.install(packages: string[])` вызван с массивом пакетов, THE Runtime SHALL устанавливать пакеты последовательно с учётом зависимостей и возвращать результат после установки всех.
6. WHEN метод `Runtime.pip.list()` вызван, THE Runtime SHALL возвращать массив объектов `{ name: string, version: string }` для всех установленных пакетов.
7. THE Runtime SHALL кэшировать загруженные wheels в VFS по пути `/tmp/pip-cache/`, чтобы повторная установка не требовала сетевых запросов.
8. WHEN Python-код выполняет `import pip` и вызывает `pip.main(['install', 'package'])`, THE Runtime SHALL перехватывать вызов и делегировать его в `Runtime.pip.install()`.

---

### Requirement 7: Выполнение Python-кода

**User Story:** Как разработчик, я хочу выполнять произвольный Python-код в Runtime и получать результаты, включая вывод в stdout/stderr и возвращаемые значения.

#### Acceptance Criteria

1. WHEN метод `Runtime.run(code: string)` вызван с валидным Python-кодом, THE Runtime SHALL выполнить код в контексте CPython-интерпретатора и вернуть результат последнего выражения, сериализованный в JSON-совместимый тип.
2. WHEN выполнение кода завершается исключением Python, THE Runtime SHALL возвращать объект `{ type: string, message: string, traceback: string }` с типом исключения, сообщением и полным traceback.
3. THE Runtime SHALL сохранять состояние между последовательными вызовами `run()` в рамках одного экземпляра: переменные, импорты и изменения VFS сохраняются.
4. WHEN код обращается к `sys.stdout`, THE Runtime SHALL перехватывать вывод через WASI fd_write shim и передавать его в callback `onStdout`.
5. WHEN код обращается к `sys.stderr`, THE Runtime SHALL перехватывать вывод через WASI fd_write shim и передавать его в callback `onStderr`.
6. IF выполнение кода превышает настраиваемый таймаут (по умолчанию 30 секунд), THEN THE Runtime SHALL прерывать выполнение через WASM interrupt mechanism и возвращать ошибку `ExecutionTimeoutError`.
7. WHEN метод `Runtime.run(code, { globals: object })` вызван с параметром `globals`, THE Runtime SHALL делать переданные JavaScript-значения доступными в Python-пространстве имён через механизм сериализации.

---

### Requirement 8: Сериализация данных между Host и Runtime

**User Story:** Как разработчик, я хочу передавать данные между JavaScript и Python без ручной сериализации, чтобы интеграция была удобной и предсказуемой.

#### Acceptance Criteria

1. THE Serializer SHALL конвертировать JavaScript `Object` в Python `dict`, JavaScript `Array` в Python `list`, JavaScript `number` в Python `int` или `float`, JavaScript `string` в Python `str`, JavaScript `null`/`undefined` в Python `None`, JavaScript `boolean` в Python `bool`.
2. THE Serializer SHALL конвертировать Python `dict` в JavaScript `Object`, Python `list`/`tuple` в JavaScript `Array`, Python `int`/`float` в JavaScript `number`, Python `str` в JavaScript `string`, Python `None` в JavaScript `null`, Python `bool` в JavaScript `boolean`.
3. FOR ALL значений примитивных типов (string, number, boolean, null, вложенные dict/list), прошедших конвертацию JS → Python → JS, THE Serializer SHALL возвращать значение, структурно эквивалентное исходному (round-trip свойство).
4. THE Serializer SHALL поддерживать сериализацию вложенных структур данных глубиной до 100 уровней без переполнения стека.
5. IF Python-объект не имеет эквивалентного JavaScript-типа (например, Python-класс, генератор), THEN THE Serializer SHALL возвращать строковое представление объекта через `repr()` и устанавливать флаг `{ __type: 'python-object', repr: string }`.

---

### Requirement 9: Изоляция и безопасность

**User Story:** Как разработчик, я хочу, чтобы каждый экземпляр Runtime был полностью изолирован, чтобы Python-код одного экземпляра не мог влиять на другой или получить доступ к ресурсам браузера за пределами своей песочницы.

#### Acceptance Criteria

1. THE Runtime SHALL выполнять каждый экземпляр Python-среды в отдельном Web Worker с отдельным WASM-модулем, обеспечивая изоляцию памяти на уровне WASM linear memory.
2. THE Runtime SHALL изолировать VFS каждого экземпляра: файлы одного экземпляра недоступны другому экземпляру через файловую систему.
3. THE Runtime SHALL ограничивать сетевые запросы из Python-кода политикой CORS браузера через WASI network shim.
4. IF Python-код пытается вызвать системный вызов, выходящий за пределы разрешённого набора WASI syscalls, THEN THE WASI_Shim SHALL возвращать код ошибки `EPERM` и не выполнять операцию.
5. THE Runtime SHALL запрещать Python-коду прямой доступ к DOM главной страницы: взаимодействие с Host возможно только через явно определённый message-passing API.
6. WHEN метод `Runtime.destroy()` вызван, THE Runtime SHALL завершать Web Worker, освобождать WASM linear memory и отклонять все ожидающие Promise с ошибкой `RuntimeDestroyedError`.
7. WHEN Runtime уничтожен, THE Runtime SHALL отклонять любые последующие вызовы методов с ошибкой `RuntimeDestroyedError`.

---

### Requirement 10: Управление жизненным циклом Runtime

**User Story:** Как разработчик, я хочу управлять жизненным циклом Runtime — перезапускать, прерывать выполнение и освобождать ресурсы — чтобы эффективно управлять памятью браузера.

#### Acceptance Criteria

1. WHEN метод `Runtime.restart()` вызван, THE Runtime SHALL сбрасывать состояние CPython-интерпретатора (переменные, импорты, sys.modules) без повторной загрузки WASM-модуля, сохраняя содержимое VFS.
2. THE Runtime SHALL предоставлять метод `Runtime.interrupt()`, который прерывает текущее выполнение кода через WASM interrupt mechanism без уничтожения Runtime.
3. WHEN метод `Runtime.destroy()` вызван, THE Runtime SHALL завершать Web Worker и освобождать все ресурсы, включая WASM linear memory, в течение 5 секунд.
4. THE Runtime SHALL предоставлять метод `Runtime.getMemoryUsage()`, возвращающий объект `{ wasmHeap: number, vfsSize: number }` с текущим потреблением памяти в байтах.
5. IF потребление WASM linear memory превышает 2 ГБ, THEN THE Runtime SHALL генерировать событие `onMemoryWarning` с текущим значением потребления памяти.

---

### Requirement 11: Парсинг и сериализация конфигурации Runtime

**User Story:** Как разработчик, я хочу передавать конфигурацию Runtime в структурированном формате и получать её обратно, чтобы сохранять и восстанавливать настройки среды.

#### Acceptance Criteria

1. WHEN метод `Runtime.init(config: RuntimeConfig)` вызван, THE Config_Parser SHALL парсить объект конфигурации и применять параметры: `pythonVersion`, `wasmUrl`, `persistenceBackend`, `autoSyncInterval`, `executionTimeout`, `allowedSyscalls`.
2. IF объект конфигурации содержит неизвестное поле, THEN THE Config_Parser SHALL игнорировать неизвестное поле и логировать предупреждение с именем поля.
3. IF объект конфигурации содержит поле с некорректным типом (например, `executionTimeout: "fast"`), THEN THE Config_Parser SHALL отклонять инициализацию с ошибкой `ConfigValidationError`, содержащей имя поля и ожидаемый тип.
4. WHEN метод `Runtime.getConfig()` вызван, THE Config_Parser SHALL возвращать текущую конфигурацию Runtime в виде объекта `RuntimeConfig`.
5. FOR ALL валидных объектов `RuntimeConfig`, прошедших через `Runtime.init(config)` и `Runtime.getConfig()`, THE Config_Parser SHALL возвращать объект, структурно эквивалентный исходному (round-trip свойство).
