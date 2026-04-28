#define PY_SSIZE_T_CLEAN
#include "Python.h"

static PyObject* test_hello(PyObject* self, PyObject* args) {
    return PyUnicode_FromString("Hello from C-extension WASM!");
}

static PyObject* test_add(PyObject* self, PyObject* args) {
    long a, b;
    if (!PyArg_ParseTuple(args, "ll", &a, &b)) return NULL;
    return PyLong_FromLong(a + b);
}

static PyMethodDef TestMethods[] = {
    {"hello", test_hello, METH_NOARGS,   "Return hello string"},
    {"add",   test_add,   METH_VARARGS,  "Add two numbers"},
    {NULL, NULL, 0, NULL}
};

static struct PyModuleDef testmodule = {
    PyModuleDef_HEAD_INIT, "testmodule", NULL, -1, TestMethods
};

PyMODINIT_FUNC PyInit_testmodule(void) {
    return PyModule_Create(&testmodule);
}
