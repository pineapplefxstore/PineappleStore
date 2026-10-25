"""Pineapple ZXP Installer - Premium Apple-Inspired Adobe Extension Installer.
Works with any .zxp file:
  - Enables PlayerDebugMode in Windows Registry for CSXS.9 -> CSXS.20
  - Unpacks .zxp into %APPDATA%\\Adobe\\CEP\\extensions\\<ExtensionName>
  - macOS Sonoma / Sequoia inspired minimalist aesthetic with embedded logo.
"""
import os
import sys
import pathlib
import zipfile
import xml.etree.ElementTree as ET
import tkinter as tk
from tkinter import filedialog, messagebox
from PIL import Image, ImageTk

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

def install_zxp(zxp_path):
    if not os.path.isfile(zxp_path):
        return False, 'File not found: ' + str(zxp_path)
    
    # 1. Enable debug mode
    enable_player_debug_mode()

    # 2. Extract bundle id & folder
    bundle_name = get_bundle_id(zxp_path)
    clean_folder = ''.join(c for c in bundle_name if c.isalnum() or c in '.-_') or 'PineappleFX'
    
    target_base = os.path.expandvars(r'%APPDATA%\Adobe\CEP\extensions')
    target_dir = os.path.join(target_base, clean_folder)

    try:
        os.makedirs(target_dir, exist_ok=True)
        with zipfile.ZipFile(zxp_path, 'r') as z:
            z.extractall(target_dir)
        return True, 'Installed successfully!\n\nLocation: ' + target_dir + '\n\nRestart After Effects and find it in Window > Extensions.'
    except Exception as e:
        return False, 'Installation failed: ' + str(e)

def resolve_resource(name):
    # Support PyInstaller _MEIPASS and local folder
    if hasattr(sys, '_MEIPASS'):
        p = os.path.join(sys._MEIPASS, name)
        if os.path.exists(p):
            return p
    # Local fallback
    local = os.path.join(os.path.dirname(__file__), '..', name)
    if os.path.exists(local):
        return local
    return name

def run_gui():
    root = tk.Tk()
    root.title('Pineapple ZXP Installer')
    root.geometry('500x380')
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

    # Top Header Container
    header_frame = tk.Frame(root, bg=BG)
    header_frame.pack(pady=(28, 14), fill='x')

    # Logo image
    png_path = resolve_resource(os.path.join('assets', 'logo.png'))
    img_tk = None
    if os.path.exists(png_path):
        try:
            pil_img = Image.open(png_path)
            pil_img = pil_img.resize((56, 56), Image.Resampling.LANCZOS)
            img_tk = ImageTk.PhotoImage(pil_img)
            logo_label = tk.Label(header_frame, image=img_tk, bg=BG)
            logo_label.image = img_tk
            logo_label.pack()
        except Exception:
            pass

    title_label = tk.Label(header_frame, text='Pineapple ZXP Installer', font=('SF Pro Display', 16, 'bold'), fg=TEXT, bg=BG)
    title_label.pack(pady=(8, 2))

    sub_label = tk.Label(header_frame, text='Designed for Adobe After Effects Extensions', font=('SF Pro Text', 10), fg=MUTED, bg=BG)
    sub_label.pack()

    # Rounded Apple Style Card
    card_frame = tk.Frame(root, bg=CARD, highlightbackground=BORDER, highlightthickness=1, padx=20, pady=18)
    card_frame.pack(padx=32, fill='x')

    selected_file = tk.StringVar(value='')

    file_display = tk.Label(card_frame, text='Drag or choose a .zxp extension file to begin', font=('SF Pro Text', 10), fg='#d1d1d6', bg=CARD, wraplength=400)
    file_display.pack(pady=(0, 14))

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
        else:
            messagebox.showerror('Installation Failed', msg)
            file_display.config(text='Installation encountered an error.', fg='#ff453a')

    btn_row = tk.Frame(card_frame, bg=CARD)
    btn_row.pack(fill='x')

    btn_choose = tk.Button(btn_row, text='Choose Package...', font=('SF Pro Text', 10, 'bold'),
                           bg='#3a3a3e', fg=TEXT, activebackground='#48484d', activeforeground=TEXT,
                           relief='flat', bd=0, padx=16, pady=8, cursor='hand2', command=pick_file)
    btn_choose.pack(side='left', expand=True, padx=(0, 6))

    btn_install = tk.Button(btn_row, text='Install Extension', font=('SF Pro Text', 10, 'bold'),
                            bg='#3a3a3e', fg=MUTED, activebackground='#feca08', activeforeground='#141416',
                            relief='flat', bd=0, padx=18, pady=8, cursor='hand2', state='disabled', command=do_install)
    btn_install.pack(side='right', expand=True, padx=(6, 0))

    # Bottom Footer
    footer = tk.Label(root, text='Automatically configures Adobe CEP PlayerDebugMode', font=('SF Pro Text', 8), fg='#636366', bg=BG)
    footer.pack(side='bottom', pady=16)

    root.mainloop()

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1].endswith('.zxp'):
        ok, msg = install_zxp(sys.argv[1])
        print(msg)
        sys.exit(0 if ok else 1)
    run_gui()
