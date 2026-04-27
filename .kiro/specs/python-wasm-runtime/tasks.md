# Implementation Plan: Python WASM Runtime

## Overview

Реализация кастомного Python WASM Runtime на TypeScript: CPython + wasi-sdk (wasm32-wasi), WASI Shim, VFS с POSIX-семантикой, персистентность через OPFS/IndexedDB, C-extensions через WASM Wheels, pip с реестром, Web Worker изоляция, сериализация JS ↔ Python.

## Tasks

- [x] 1. Настройка структуры проекта и базовых типов
  - Создать директорию `src/` с подпапками: `proxy/`, `worker/`, `wasi/`, `vfs/`, `persistence/`, `pip/`, `serializer/`, `config/`, `errors/`
  - Определить все TypeScript-интерфейсы и типы: `RuntimeConfig`, `RunOptions`, `RunResult`, `PythonError`, `MemoryUsage`, `WorkerRequest`, `WorkerResponse`, `VFSNode`, `FileDescriptor`, `FileStat`, `DirEntry`, `WASMWheelEntry`, `InstallResult`, `PackageInfo`
  - Определить иерархию классов ошибок: `RuntimeError`, `InitializationError`, `WASMLoadError`, `ConfigValidationError`, `ExecutionError`, `PythonException`, `ExecutionTimeoutError`, `FSError`, `FileNotFoundError`, `FSOperationError`, `PackageError`, `PackageNotFoundError`, `NoWASMWheelError`, `IncompatiblePackageError`, `SerializationError`, `SerializationDepthError`, `RuntimeDestroyedError`
  - Настроить `tsconfig.json`, `package.json` с зависимостями (fast-check, vitest)
  - _Requirements: 1.1, 2.1, 3.1, 7.2, 9.6_

- [x] 2. Реализация ConfigParser
  - [x] 2.1 Реализовать `ConfigParser` в `src/config/ConfigParser.ts`
    - Метод `parse(raw: unknown): RuntimeConfig` с применением дефолтов из `CONFIG_SCHEMA`
    - Метод `validate(config: RuntimeConfig): ValidationResult` с проверкой типов каждого поля
    - Метод `serialize(config: RuntimeConfig): Record<string, unknown>`
    - Логирование предупреждений для неизвестных полей
    - _Requirements: 11.1, 11.2, 11.3_

  - [ ]* 2.2 Написать property-тест для ConfigParser: round-trip конфигурации
    - **Property 26: Round-trip конфигурации Runtime**
    - **Validates: Requirements 11.1, 11.4, 11.5**

  - [ ]* 2.3 Написать property-тест для ConfigParser: игнорирование неизвестных полей
    - **Property 27: Игнорирование неизвестных полей конфигурации**
    - **Validates: Requirements 11.2**

  - [ ]* 2.4 Написать property-тест для ConfigParser: ConfigValidationError для некорректных типов
    - **Property 28: ConfigValidationError для некорректных типов полей**
    - **Validates: Requirements 11.3**

- [x] 3. Реализация Serializer (JS ↔ Python)
  - [x] 3.1 Реализовать `Serializer` в `src/serializer/Serializer.ts`
    - Метод `jsToJson(value: unknown): string` — рекурсивный обход с счётчиком глубины (лимит 100)
    - Метод `jsonToJs(json: string): unknown` — парсинг JSON из CPython
    - Маппинг типов согласно таблице в design.md
    - Маркировка non-serializable объектов: `{ __type: 'python-object', repr: string }`
    - Бросать `SerializationDepthError` при превышении 100 уровней
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ]* 3.2 Написать property-тест для Serializer: round-trip JS → Python → JS
    - **Property 20: Round-trip сериализации JS ↔ Python**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4**

  - [ ]* 3.3 Написать property-тест для Serializer: маркировка non-serializable объектов
    - **Property 21: Маркировка non-serializable Python объектов**
    - **Validates: Requirements 8.5**

- [x] 4. Реализация VirtualFileSystem
  - [x] 4.1 Реализовать `VirtualFileSystem` в `src/vfs/VirtualFileSystem.ts`
    - In-memory хранилище `Map<string, VFSNode>`
    - WASI-level операции: `pathOpen`, `fdRead`, `fdWrite`, `fdSeek`, `fdClose`, `pathStat`, `pathCreateDirectory`, `pathRemoveDirectory`, `pathUnlinkFile`, `pathRename`, `pathReaddir`
    - Host-level операции: `writeFile`, `readFile`, `listDir`, `sync`, `clearPersistent`
    - Предустановленная структура директорий при инициализации: `/home/user/`, `/tmp/`, `/usr/lib/python3.x/`, `/usr/local/lib/python3.x/site-packages/`
    - Бросать `FileNotFoundError` при `readFile` несуществующего пути
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

  - [ ]* 4.2 Написать property-тест для VFS: round-trip чтения/записи
    - **Property 5: Round-trip чтения/записи VFS**
    - **Validates: Requirements 3.2, 3.3, 3.6, 3.7**

  - [ ]* 4.3 Написать property-тест для VFS: FileNotFoundError для несуществующих путей
    - **Property 6: FileNotFoundError для несуществующих путей**
    - **Validates: Requirements 3.8**

  - [ ]* 4.4 Написать property-тест для VFS: полнота listDir
    - **Property 7: Полнота listDir**
    - **Validates: Requirements 3.9**

- [x] 5. Checkpoint — убедиться, что все тесты проходят
  - Убедиться, что все тесты проходят, задать вопросы пользователю при необходимости.

- [x] 6. Реализация PersistenceBackend
  - [x] 6.1 Реализовать `OPFSBackend` в `src/persistence/OPFSBackend.ts`
    - Использовать `FileSystemSyncAccessHandle` для синхронных операций
    - Методы: `save`, `load`, `delete`, `listAll`, `clear`
    - _Requirements: 4.1, 4.3, 4.4, 4.7_

  - [x] 6.2 Реализовать `IndexedDBBackend` в `src/persistence/IndexedDBBackend.ts`
    - Object store `vfs-files`, ключ — путь, значение — `Uint8Array`
    - Методы: `save`, `load`, `delete`, `listAll`, `clear`
    - _Requirements: 4.2, 4.3, 4.4, 4.7_

  - [x] 6.3 Реализовать `NoPersistenceBackend` и функцию `detectBackend()` в `src/persistence/index.ts`
    - Автоматический выбор: OPFS → IndexedDB → none
    - _Requirements: 4.6_

  - [x] 6.4 Интегрировать `PersistenceBackend` в `VirtualFileSystem`
    - Метод `sync()` сохраняет изменённые файлы из `/home/user/` в бэкенд
    - При инициализации VFS восстанавливает файлы из бэкенда
    - Поддержка `autoSyncInterval` через `setInterval`
    - _Requirements: 4.4, 4.5, 4.8_

  - [ ]* 6.5 Написать property-тест для PersistenceBackend: round-trip персистентности VFS
    - **Property 9: Round-trip персистентности VFS**
    - **Validates: Requirements 4.4, 4.5**

  - [ ]* 6.6 Написать property-тест для PersistenceBackend: очистка персистентных данных
    - **Property 10: Очистка персистентных данных**
    - **Validates: Requirements 4.7**

- [x] 7. Реализация WASIShim
  - [x] 7.1 Реализовать `WASIShim` в `src/wasi/WASIShim.ts`
    - Метод `buildImports(vfs, callbacks): WASIImports` — генерирует import object для `WebAssembly.instantiate`
    - Реализовать все необходимые syscalls: `fd_read`, `fd_write`, `fd_seek`, `fd_close`, `fd_fdstat_get`, `path_open`, `path_create_directory`, `path_remove_directory`, `path_unlink_file`, `path_rename`, `path_filestat_get`, `path_readdir`, `clock_time_get`, `random_get`, `proc_exit`, `args_get`, `args_sizes_get`, `environ_get`, `environ_sizes_get`
    - `fd_write` для fd=1 → `onStdout`, для fd=2 → `onStderr`
    - `clock_time_get` через `performance.now()` / `Date.now()`
    - `random_get` через `crypto.getRandomValues()`
    - Для нереализованных syscalls — возвращать `ENOSYS` + `console.warn`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 7.2 Реализовать interrupt-механизм в `WASIShim`
    - Метод `setInterruptBuffer(sab: SharedArrayBuffer): void`
    - Проверка `Atomics.load(interruptBuffer, 0)` на каждом `fd_write` и периодически в `clock_time_get`
    - При ненулевом значении — бросать исключение для `KeyboardInterrupt` в CPython
    - _Requirements: 10.2_

  - [x] 7.3 Реализовать whitelist syscalls (EPERM для запрещённых)
    - Проверять `allowedSyscalls` из конфига перед каждым syscall
    - Возвращать `EPERM` для syscalls вне whitelist
    - _Requirements: 9.4_

  - [ ]* 7.4 Написать property-тест для WASIShim: маршрутизация fd_write по дескриптору
    - **Property 2: Маршрутизация fd_write по файловому дескриптору**
    - **Validates: Requirements 2.2, 2.3**

  - [ ]* 7.5 Написать property-тест для WASIShim: монотонность clock_time_get
    - **Property 3: Монотонность clock_time_get**
    - **Validates: Requirements 2.4**

  - [ ]* 7.6 Написать property-тест для WASIShim: ENOSYS для неизвестных syscalls
    - **Property 4: ENOSYS для неизвестных syscalls**
    - **Validates: Requirements 2.6**

  - [ ]* 7.7 Написать property-тест для WASIShim: EPERM для запрещённых syscalls
    - **Property 22: EPERM для запрещённых syscalls**
    - **Validates: Requirements 9.4**

- [x] 8. Checkpoint — убедиться, что все тесты проходят
  - Убедиться, что все тесты проходят, задать вопросы пользователю при необходимости.

- [x] 9. Реализация WASMExtensionLoader
  - [x] 9.1 Реализовать `WASMExtensionLoader` в `src/worker/WASMExtensionLoader.ts`
    - Метод `register(soPath, wasmBytes)` — регистрирует `.so` как WASM-модуль
    - Метод `load(moduleName): PyObject` — загружает и линкует модуль с CPython через `WebAssembly.instantiate()` с importObject из экспортов CPython
    - Реестр `WASMWheelRegistry` с `Map<string, WASMWheelEntry>`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 9.2 Реализовать кастомный Python import hook для `.so`-файлов
    - Python-код, регистрируемый через `sys.meta_path`, перехватывает `import` для `.so`
    - Вызывает `WASMExtensionLoader.load()` через WASI callback
    - _Requirements: 5.3, 5.4_

- [x] 10. Реализация PipManager
  - [x] 10.1 Реализовать `PipManager` в `src/pip/PipManager.ts`
    - Метод `install(packages)` — алгоритм: кэш → реестр WASM Wheels → PyPI JSON API → pure-Python wheel
    - Метод `list(): Promise<PackageInfo[]>` — читает установленные пакеты из `site-packages`
    - Кэширование wheels в `/tmp/pip-cache/`
    - Рекурсивная установка зависимостей с топологической сортировкой
    - Бросать `PackageNotFoundError`, `NoWASMWheelError`, `IncompatiblePackageError` в соответствующих случаях
    - Перехват `pip.main()` из Python-кода
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_

  - [ ]* 10.2 Написать property-тест для PipManager: NoWASMWheelError для отсутствующих пакетов
    - **Property 11: NoWASMWheelError для отсутствующих пакетов**
    - **Validates: Requirements 5.6**

  - [ ]* 10.3 Написать property-тест для PipManager: PackageNotFoundError для несуществующих пакетов
    - **Property 12: PackageNotFoundError для несуществующих пакетов**
    - **Validates: Requirements 6.3**

  - [ ]* 10.4 Написать property-тест для PipManager: топологический порядок установки зависимостей
    - **Property 13: Топологический порядок установки зависимостей**
    - **Validates: Requirements 6.5, 6.6**

  - [ ]* 10.5 Написать property-тест для PipManager: кэширование wheels при повторной установке
    - **Property 14: Кэширование wheels при повторной установке**
    - **Validates: Requirements 6.7**

- [x] 11. Реализация WorkerEntrypoint и PythonRuntime
  - [x] 11.1 Реализовать `PythonRuntime` в `src/worker/PythonRuntime.ts`
    - Загрузка CPython WASM через `WebAssembly.instantiateStreaming()`
    - Инициализация `WASIShim`, `VirtualFileSystem`, `PersistenceBackend`, `WASMExtensionLoader`, `PipManager`, `Serializer`
    - Монтирование stdlib в VFS при инициализации
    - Метод `run(code, globals?)` — вызов `PyRun_String`, сериализация globals через `Serializer`, возврат результата
    - Метод `restart()` — сброс CPython-состояния без перезагрузки WASM, сохранение VFS
    - Метод `getMemoryUsage()` — возврат `{ wasmHeap, vfsSize }`
    - Идемпотентность: повторный `init()` возвращает существующий экземпляр
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 10.1, 10.4_

  - [x] 11.2 Реализовать `WorkerEntrypoint` в `src/worker/WorkerEntrypoint.ts`
    - Обработчик `self.onmessage` для всех типов `WorkerRequest`
    - Маршрутизация: `run`, `restart`, `destroy`, `fs.*`, `pip.*`, `memory`
    - Отправка `WorkerResponse` через `self.postMessage`
    - Перехват `self.onerror` и `self.onunhandledrejection`
    - _Requirements: 1.4, 9.5_

  - [ ]* 11.3 Написать property-тест для PythonRuntime: идемпотентность инициализации
    - **Property 1: Идемпотентность инициализации**
    - **Validates: Requirements 1.5**

  - [ ]* 11.4 Написать property-тест для PythonRuntime: корректность результата выполнения
    - **Property 15: Корректность результата выполнения Python-кода**
    - **Validates: Requirements 7.1**

  - [ ]* 11.5 Написать property-тест для PythonRuntime: структура объекта ошибки Python
    - **Property 16: Структура объекта ошибки Python**
    - **Validates: Requirements 7.2**

  - [ ]* 11.6 Написать property-тест для PythonRuntime: сохранение состояния между вызовами run()
    - **Property 17: Сохранение состояния между вызовами run()**
    - **Validates: Requirements 7.3**

  - [ ]* 11.7 Написать property-тест для PythonRuntime: перехват потоков вывода
    - **Property 18: Перехват потоков вывода**
    - **Validates: Requirements 7.4, 7.5**

  - [ ]* 11.8 Написать property-тест для PythonRuntime: доступность globals в Python
    - **Property 19: Доступность globals в Python-пространстве имён**
    - **Validates: Requirements 7.7**

  - [ ]* 11.9 Написать property-тест для PythonRuntime: сброс состояния при restart() с сохранением VFS
    - **Property 24: Сброс состояния при restart() с сохранением VFS**
    - **Validates: Requirements 10.1**

  - [ ]* 11.10 Написать property-тест для PythonRuntime: корректность getMemoryUsage()
    - **Property 25: Корректность getMemoryUsage()**
    - **Validates: Requirements 10.4**

- [x] 12. Checkpoint — убедиться, что все тесты проходят
  - Убедиться, что все тесты проходят, задать вопросы пользователю при необходимости.

- [x] 13. Реализация RuntimeProxy (Main Thread)
  - [x] 13.1 Реализовать `RuntimeProxy` в `src/proxy/RuntimeProxy.ts`
    - Метод `init(config)` — создаёт Worker, передаёт `SharedArrayBuffer` для interrupt, ожидает `{ type: 'ready' }`
    - Метод `run(code, options?)` — отправляет `{ type: 'run' }`, возвращает Promise через `MessageChannel`
    - Метод `interrupt()` — `Atomics.store(interruptBuffer, 0, 1)`
    - Метод `restart()`, `destroy()`, `getMemoryUsage()`, `getConfig()`
    - Свойства `fs` (`FSProxy`) и `pip` (`PipProxy`) — делегируют в Worker через `postMessage`
    - Callbacks: `onStdout`, `onStderr`, `onWarning`, `onMemoryWarning`
    - После `destroy()` — все методы бросают `RuntimeDestroyedError`
    - Таймаут выполнения через `setTimeout` + `interrupt()`
    - _Requirements: 1.1, 1.2, 1.4, 7.6, 9.6, 9.7, 10.2, 10.3_

  - [x] 13.2 Реализовать `FSProxy` и `PipProxy` в `src/proxy/`
    - `FSProxy`: `writeFile`, `readFile`, `listDir`, `sync`, `clearPersistent`
    - `PipProxy`: `install`, `list`
    - _Requirements: 3.6, 3.7, 3.8, 3.9, 6.1, 6.6_

  - [ ]* 13.3 Написать property-тест для RuntimeProxy: изоляция VFS между экземплярами
    - **Property 8: Изоляция VFS между экземплярами Runtime**
    - **Validates: Requirements 3.10, 9.2**

  - [ ]* 13.4 Написать property-тест для RuntimeProxy: отклонение вызовов после destroy()
    - **Property 23: Отклонение вызовов после destroy()**
    - **Validates: Requirements 9.6, 9.7**

- [x] 14. Финальная интеграция и экспорт публичного API
  - [x] 14.1 Создать точку входа `src/index.ts`
    - Экспортировать `RuntimeProxy` как `PythonRuntime`
    - Экспортировать все публичные типы и классы ошибок
    - _Requirements: 1.1_

  - [x] 14.2 Написать unit-тесты для интеграционных сценариев
    - Успешная инициализация с mock WASM-модулем
    - Монтирование stdlib при инициализации (Requirement 1.7)
    - Предустановленная структура директорий VFS (Requirement 3.5)
    - Ошибка сети при загрузке WASM (Requirement 1.3)
    - Выбор OPFS/IndexedDB/none бэкенда (Requirements 4.1, 4.2, 4.6)
    - Таймаут выполнения (Requirement 7.6)
    - Interrupt через SharedArrayBuffer (Requirement 10.2)
    - Завершение Worker в течение 5 секунд (Requirement 10.3)
    - `onMemoryWarning` при превышении 2 ГБ (Requirement 10.5)
    - `IncompatiblePackageError` для non-wasm wheels (Requirement 6.4)
    - _Requirements: 1.3, 1.7, 3.5, 4.1, 4.2, 4.6, 6.4, 7.6, 10.2, 10.3, 10.5_

- [x] 15. Финальный checkpoint — убедиться, что все тесты проходят
  - Убедиться, что все тесты проходят, задать вопросы пользователю при необходимости.

## Notes

- Задачи, помеченные `*`, опциональны и могут быть пропущены для ускорения MVP
- Каждая задача ссылается на конкретные требования для трассируемости
- Property-тесты используют библиотеку [fast-check](https://fast-check.io/), минимум 100 итераций каждый
- WASM-модуль в тестах заменяется mock-реализацией с минимальным CPython API
- Для тестов Worker-компонентов используется jsdom с mock Worker API или Playwright
- COOP/COEP заголовки обязательны для `SharedArrayBuffer` (interrupt-механизм)
