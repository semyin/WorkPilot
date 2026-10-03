"""Fixed Office-to-PDF conversion; embedded by the dedicated sandboxed worker."""
import ctypes
import os
import sys
import threading
from pathlib import Path

def normal_path(path):
    text = str(path)
    if text.startswith("\\\\?\\UNC\\"):
        return Path("\\\\" + text[8:])
    return Path(text.removeprefix("\\\\?\\"))


cwd = normal_path(Path.cwd())
program = normal_path(sys.executable).parent
dll_directory = os.add_dll_directory(str(program))
library = ctypes.CDLL(str(program / "mergedlo.dll"), winmode=0x1100)
library.libreofficekit_hook_2.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
library.libreofficekit_hook_2.restype = ctypes.c_void_p
print("office: initializing", file=sys.stderr, flush=True)
office = library.libreofficekit_hook_2(
    str(program).encode(), (cwd / "profile").as_uri().encode()
)
if not office:
    raise RuntimeError("Office initialization failed")
print("office: initialized", file=sys.stderr, flush=True)

import uno
import unohelper
from com.sun.star.awt import XCallback
from com.sun.star.beans import PropertyValue

context = uno.getComponentContext()
done = threading.Event()
errors = []


def property_value(name, value):
    prop = PropertyValue()
    prop.Name, prop.Value = name, value
    return prop


class Convert(unohelper.Base, XCallback):
    def notify(self, data):
        try:
            print("office: main thread callback", file=sys.stderr, flush=True)
            files = [cwd / ("input." + ext) for ext in ("docx", "xlsx", "pptx")]
            files = [path for path in files if path.is_file()]
            if len(files) != 1 or files[0].is_symlink():
                raise ValueError("Expected one regular Office input")
            source = files[0]
            if not 0 < source.stat().st_size <= 32 * 1024 * 1024:
                raise ValueError("Office input exceeds size limit")
            target = cwd / "preview.pdf"
            if target.exists():
                raise ValueError("Preview output already exists")
            desktop = context.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", context
            )
            doc = desktop.loadComponentFromURL(source.as_uri(), "_blank", 0, (
                property_value("Hidden", True), property_value("ReadOnly", True),
                property_value("MacroExecutionMode", 0), property_value("UpdateDocMode", 0),
            ))
            if not doc:
                raise ValueError("Office document could not be opened")
            print("office: loaded", file=sys.stderr, flush=True)
            filters = {".docx": "writer_pdf_Export", ".xlsx": "calc_pdf_Export", ".pptx": "impress_pdf_Export"}
            doc.storeToURL(target.as_uri(), (
                property_value("FilterName", filters[source.suffix]), property_value("Overwrite", False),
            ))
            doc.close(True)
            if not 0 < target.stat().st_size <= 32 * 1024 * 1024:
                raise ValueError("Converted PDF exceeds size limit")
            print("office: saved", file=sys.stderr, flush=True)
        except Exception as error:
            errors.append(str(error))
        finally:
            done.set()


callback = context.ServiceManager.createInstanceWithContext("com.sun.star.awt.AsyncCallback", context)
job = Convert()
callback.addCallback(job, None)
if not done.wait(75):
    raise TimeoutError("Office conversion timed out")
if errors:
    raise RuntimeError(errors[0])
