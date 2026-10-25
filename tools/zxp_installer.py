"""Pineapple ZXP Installer - Premium Apple-Inspired Adobe Extension Installer.
Works with any .zxp file:
  - Enables PlayerDebugMode in Windows Registry for CSXS.9 -> CSXS.20
  - Unpacks .zxp into %APPDATA%\\Adobe\\CEP\\extensions\\<ExtensionName>
  - macOS Sonoma / Sequoia inspired minimalist aesthetic with embedded logo.
  - Extension Manager: Lists installed CEP extensions, enables 1-click uninstallation.
  - Registers in Windows Control Panel (Add/Remove Programs) under Publisher: PineappleFX.
"""
import os
import sys
import pathlib
import shutil
import zipfile
import xml.etree.ElementTree as ET
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from PIL import Image, ImageTk

APP_DISPLAY = 'Pineapple ZXP Installer'
PUBLISHER = 'PineappleFX'
VERSION = '2.0.0'

def enable_player_debug_mode():
    try:
        import winreg
        for v in range(9, 21):
            key_path = r'Software\Adobe\CSXS.%d' % v
            try:
                with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as k:
                    winreg.SetValueEx(k, 'PlayerDebugMode', 0, winreg.REG_SZ, '1')
            except Exception:
                pass
        return True
    except Exception:
        return False

def get_bundle_id(zxp_path):
    try:
        with zipfile.ZipFile(zxp_path, 'r') as z:
            manifest_candidates = [n for n in z.namelist() if n.endswith('manifest.xml')]
            if manifest_candidates:
                data = z.read(manifest_candidates[0])
                root = ET.fromstring(data)
                bundle = root.attrib.get('ExtensionBundleId')
                if bundle:
                    return bundle
    except Exception:
        pass
    return pathlib.Path(zxp_path).stem

def cep_extensions_path():
    appdata = os.environ.get('APPDATA') or str(pathlib.Path.home() / 'AppData' / 'Roaming')
    p = pathlib.Path(appdata) / 'Adobe' / 'CEP' / 'extensions'
    p.mkdir(parents=True, exist_ok=True)
    return p

def list_installed_extensions():
    ext_dir = cep_extensions_path()
    found = []
    if ext_dir.exists():
        for d in ext_dir.iterdir():
            if d.is_dir():
                manifest = d / 'CSXS' / 'manifest.xml'
                name = d.name
                ver = ''
                if manifest.is_file():
                    try:
                        root = ET.fromstring(manifest.read_bytes())
                        name = root.attrib.get('ExtensionBundleName') or root.attrib.get('ExtensionBundleId') or d.name
                        ver = root.attrib.get('ExtensionBundleVersion', '')
                    except Exception:
                        pass
                found.append({'dir_name': d.name, 'name': name, 'version': ver, 'path': str(d)})
    return sorted(found, key=lambda x: x['name'].lower())

def uninstall_extension(dir_name):
    target = cep_extensions_path() / dir_name
    if target.exists() and target.is_dir():
        shutil.rmtree(target, ignore_errors=True)
        return True
    return False

def install_zxp(zxp_path):
    if not os.path.isfile(zxp_path):
        return False, 'File not found: ' + str(zxp_path)
    
    # 1. Enable debug mode
    enable_player_debug_mode()

    # 2. Extract bundle id & folder
    bundle_name = get_bundle_id(zxp_path)
    clean_folder = ''.join(c for c in bundle_name if c.isalnum() or c in '.-_') or 'PineappleExtension'
    
    target_dir = cep_extensions_path() / clean_folder

    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zxp_path, 'r') as z:
            z.extractall(target_dir)
        register_zxp_control_panel()
        return True, 'Installed successfully!\n\nLocation: ' + str(target_dir) + '\n\nRestart After Effects and find it in Window > Extensions.'
    except Exception as e:
        return False, 'Installation failed: ' + str(e)

def register_zxp_control_panel():
    try:
        import winreg
        appdata = os.environ.get('APPDATA') or str(pathlib.Path.home() / 'AppData' / 'Roaming')
        pfx_dir = pathlib.Path(appdata) / 'PineappleFX'
        pfx_dir.mkdir(parents=True, exist_ok=True)
        
        # Copy running exe into APPDATA
        uninst_exe = pfx_dir / 'Pineapple-ZXP-Installer.exe'
        if getattr(sys, 'frozen', False):
            cur = sys.executable
            if os.path.abspath(cur) != os.path.abspath(str(uninst_exe)):
                shutil.copy2(cur, str(uninst_exe))

        ico_dest = pfx_dir / 'logo.ico'
        ico_src = resolve_resource(os.path.join('assets', 'logo.ico'))
        if os.path.exists(ico_src):
            shutil.copy2(ico_src, str(ico_dest))

        key_path = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\PineappleZXPInstaller'
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as k:
            winreg.SetValueEx(k, 'DisplayName', 0, winreg.REG_SZ, APP_DISPLAY)
            winreg.SetValueEx(k, 'DisplayVersion', 0, winreg.REG_SZ, VERSION)
            winreg.SetValueEx(k, 'Publisher', 0, winreg.REG_SZ, PUBLISHER)
            winreg.SetValueEx(k, 'InstallLocation', 0, winreg.REG_SZ, str(pfx_dir))
            
            uninst_cmd = f'"{uninst_exe}" --uninstall' if uninst_exe.exists() else f'"{sys.executable}" -m tools.zxp_installer --uninstall'
            winreg.SetValueEx(k, 'UninstallString', 0, winreg.REG_SZ, uninst_cmd)
            winreg.SetValueEx(k, 'QuietUninstallString', 0, winreg.REG_SZ, uninst_cmd + ' --yes')
            
            icon_path = str(ico_dest if ico_dest.exists() else uninst_exe)
            winreg.SetValueEx(k, 'DisplayIcon', 0, winreg.REG_SZ, icon_path)
            winreg.SetValueEx(k, 'HelpLink', 0, winreg.REG_SZ, 'https://pineapplestore.vercel.app/faq')
            winreg.SetValueEx(k, 'URLInfoAbout', 0, winreg.REG_SZ, 'https://pineapplestore.vercel.app')
            winreg.SetValueEx(k, 'NoModify', 0, winreg.REG_DWORD, 1)
            winreg.SetValueEx(k, 'NoRepair', 0, winreg.REG_DWORD, 1)
        return True
    except Exception:
        return False

def uninstall_zxp_installer():
    try:
        import winreg
        key_path = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\PineappleZXPInstaller'
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
    except Exception:
        pass
    return True, 'Pineapple ZXP Installer removed from system.'

def resolve_resource(name):
    if hasattr(sys, '_MEIPASS'):
        p = os.path.join(sys._MEIPASS, name)
        if os.path.exists(p):
            return p
    local = os.path.join(os.path.dirname(__file__), '..', name)
    if os.path.exists(local):
        return local
    return name

def run_gui():
    enable_player_debug_mode()
    register_zxp_control_panel()

    root = tk.Tk()
    root.title('Pineapple ZXP Installer')
    root.geometry('560x520')
    root.resizable(False, False)
    
    # Apple dark mode palette
    BG = '#1e1e20'
    CARD = '#2a2a2e'
    BORDER = '#38383c'
    ACCENT = '#feca08'
    TEXT = '#f5f5f7'
    MUTED = '#86868b'
    
    root.configure(bg=BG)

    # Set icon
    ico_path = resolve_resource(os.path.join('assets', 'logo.ico'))
    if os.path.exists(ico_path):
        try:
            root.iconbitmap(ico_path)
        except Exception:
            pass

    # Top Header
    header_frame = tk.Frame(root, bg=BG)
    header_frame.pack(pady=(20, 10), fill='x')

    png_path = resolve_resource(os.path.join('assets', 'logo.png'))
    img_tk = None
    if os.path.exists(png_path):
        try:
            pil_img = Image.open(png_path).resize((52, 52), Image.Resampling.LANCZOS)
            img_tk = ImageTk.PhotoImage(pil_img)
            logo_label = tk.Label(header_frame, image=img_tk, bg=BG)
            logo_label.image = img_tk
            logo_label.pack()
        except Exception:
            pass

    tk.Label(header_frame, text='Pineapple ZXP Installer', font=('SF Pro Display', 16, 'bold'), fg=TEXT, bg=BG).pack(pady=(6, 2))
    tk.Label(header_frame, text='Universal Extension Manager for Adobe After Effects', font=('SF Pro Text', 10), fg=MUTED, bg=BG).pack()

    # Install Card
    card_frame = tk.Frame(root, bg=CARD, highlightbackground=BORDER, highlightthickness=1, padx=20, pady=14)
    card_frame.pack(padx=28, fill='x')

    selected_file = tk.StringVar(value='')

    file_display = tk.Label(card_frame, text='Drag or choose any .zxp extension file to install', font=('SF Pro Text', 10), fg='#d1d1d6', bg=CARD, wraplength=460)
    file_display.pack(pady=(0, 10))

    def pick_file():
        fn = filedialog.askopenfilename(title='Select .zxp Extension', filetypes=[('After Effects ZXP Package', '*.zxp'), ('All Files', '*.*')])
        if fn:
            selected_file.set(fn)
            base_fn = os.path.basename(fn)
            file_display.config(text=base_fn, fg=ACCENT, font=('SF Pro Text', 10, 'bold'))
            btn_install.config(state='normal', bg=ACCENT, fg='#141416')

    def do_install():
        fn = selected_file.get()
        if not fn:
            messagebox.showwarning('Select File', 'Please select a .zxp extension file first.')
            return
        btn_install.config(state='disabled', text='Installing...')
        root.update()
        ok, msg = install_zxp(fn)
        btn_install.config(state='normal', text='Install Extension')
        if ok:
            messagebox.showinfo('Installation Complete', msg)
            file_display.config(text='Installed successfully! Restart After Effects.', fg='#34c759')
            refresh_extensions()
        else:
            messagebox.showerror('Installation Failed', msg)
            file_display.config(text='Installation encountered an error.', fg='#ff453a')

    btn_row = tk.Frame(card_frame, bg=CARD)
    btn_row.pack(fill='x')

    btn_choose = tk.Button(btn_row, text='Choose .ZXP File...', font=('SF Pro Text', 10, 'bold'),
                           bg='#3a3a3e', fg=TEXT, activebackground='#48484d', activeforeground=TEXT,
                           relief='flat', bd=0, padx=16, pady=7, cursor='hand2', command=pick_file)
    btn_choose.pack(side='left', expand=True, padx=(0, 6))

    btn_install = tk.Button(btn_row, text='Install Extension', font=('SF Pro Text', 10, 'bold'),
                            bg='#3a3a3e', fg=MUTED, activebackground='#feca08', activeforeground='#141416',
                            relief='flat', bd=0, padx=18, pady=7, cursor='hand2', state='disabled', command=do_install)
    btn_install.pack(side='right', expand=True, padx=(6, 0))

    # Extension Manager Section (New Apple-style feature)
    mgr_frame = tk.Frame(root, bg=CARD, highlightbackground=BORDER, highlightthickness=1, padx=16, pady=10)
    mgr_frame.pack(padx=28, pady=(12, 0), fill='both', expand=True)

    mgr_header = tk.Frame(mgr_frame, bg=CARD)
    mgr_header.pack(fill='x', pady=(0, 6))
    tk.Label(mgr_header, text='INSTALLED EXTENSIONS', font=('SF Pro Text', 9, 'bold'), fg=MUTED, bg=CARD).pack(side='left')

    def do_remove_selected():
        sel = listbox.curselection()
        if not sel:
            messagebox.showinfo('Select Extension', 'Select an extension from the list below to remove.')
            return
        item = current_items[sel[0]]
        if messagebox.askyesno('Confirm Remove', f'Uninstall extension "{item["name"]}"?'):
            if uninstall_extension(item['dir_name']):
                messagebox.showinfo('Removed', f'Extension "{item["name"]}" has been removed.')
                refresh_extensions()
            else:
                messagebox.showerror('Error', 'Failed to remove extension directory.')

    btn_del = tk.Button(mgr_header, text='Uninstall Selected', font=('SF Pro Text', 8, 'bold'),
                        bg='#482424', fg='#ff6b6b', activebackground='#632c2c', activeforeground='#ffffff',
                        relief='flat', bd=0, padx=8, pady=2, cursor='hand2', command=do_remove_selected)
    btn_del.pack(side='right')

    list_container = tk.Frame(mgr_frame, bg='#141416')
    list_container.pack(fill='both', expand=True)

    listbox = tk.Listbox(list_container, font=('SF Pro Text', 9), bg='#141416', fg='#e5e5ea',
                         selectbackground=ACCENT, selectforeground='#141416',
                         relief='flat', highlightthickness=0, bd=0)
    listbox.pack(side='left', fill='both', expand=True, padx=4, pady=4)

    scrollbar = tk.Scrollbar(list_container, orient='vertical', command=listbox.yview)
    scrollbar.pack(side='right', fill='y')
    listbox.config(yscrollcommand=scrollbar.set)

    current_items = []

    def refresh_extensions():
        nonlocal current_items
        listbox.delete(0, 'end')
        current_items = list_installed_extensions()
        if not current_items:
            listbox.insert('end', ' No CEP extensions found in %APPDATA%/Adobe/CEP/extensions')
        else:
            for it in current_items:
                lbl = f" • {it['name']}" + (f" (v{it['version']})" if it['version'] else "")
                listbox.insert('end', lbl)

    refresh_extensions()

    # Footer
    footer = tk.Label(root, text='Registered in Windows Control Panel • Publisher: PineappleFX',
                      font=('SF Pro Text', 8), fg='#636366', bg=BG)
    footer.pack(side='bottom', pady=10)

    root.mainloop()

if __name__ == '__main__':
    if '--uninstall' in sys.argv:
        ok, msg = uninstall_zxp_installer()
        print(msg)
        sys.exit(0 if ok else 1)
    if len(sys.argv) > 1 and sys.argv[1].endswith('.zxp'):
        ok, msg = install_zxp(sys.argv[1])
        print(msg)
        sys.exit(0 if ok else 1)
    run_gui()
