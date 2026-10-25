"""Pineapple ZXP Installer - Universal GUI and CLI ZXP Extension Installer for Adobe After Effects.
Works with any .zxp file:
  - Automatically enables PlayerDebugMode in Windows Registry for CSXS.9 -> CSXS.20
  - Unpacks .zxp into %APPDATA%\\Adobe\\CEP\\extensions\\<ExtensionName>
  - Simple file-picker GUI.
"""
import os
import sys
import pathlib
import zipfile
import xml.etree.ElementTree as ET
import tkinter as tk
from tkinter import filedialog, messagebox

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
        return True, 'Successfully installed to:\n' + target_dir + '\n\nRestart After Effects and open Window -> Extensions.'
    except Exception as e:
        return False, 'Installation failed: ' + str(e)

def run_gui():
    root = tk.Tk()
    root.title('Pineapple ZXP Installer')
    root.geometry('460x280')
    root.resizable(False, False)
    root.configure(bg='#141416')

    title_label = tk.Label(root, text='Pineapple ZXP Installer', font=('Segoe UI', 15, 'bold'), fg='#feca08', bg='#141416')
    title_label.pack(pady=(20, 5))

    desc_label = tk.Label(root, text='Fast, one-click installer for Adobe CEP / After Effects extensions', font=('Segoe UI', 9), fg='#a8a8ad', bg='#141416')
    desc_label.pack(pady=(0, 20))

    selected_file = tk.StringVar(value='')

    status_label = tk.Label(root, text='Select a .zxp file to install', font=('Segoe UI', 9), fg='#c9c9ce', bg='#141416', wraplength=420)
    status_label.pack(pady=(0, 15))

    def pick_file():
        fn = filedialog.askopenfilename(title='Select .zxp Extension', filetypes=[('ZXP Extension', '*.zxp'), ('All Files', '*.*')])
        if fn:
            selected_file.set(fn)
            status_label.config(text=os.path.basename(fn), fg='#feca08')

    def do_install():
        fn = selected_file.get()
        if not fn:
            messagebox.showwarning('Select File', 'Please choose a .zxp file first.')
            return
        btn_install.config(state='disabled', text='Installing...')
        root.update()
        ok, msg = install_zxp(fn)
        btn_install.config(state='normal', text='Install Extension')
        if ok:
            messagebox.showinfo('Success', msg)
            status_label.config(text='Installed successfully! Restart After Effects.', fg='#22c55e')
        else:
            messagebox.showerror('Error', msg)
            status_label.config(text='Installation failed.', fg='#ff4d4f')

    btn_frame = tk.Frame(root, bg='#141416')
    btn_frame.pack(pady=10)

    btn_browse = tk.Button(btn_frame, text='Browse .zxp...', font=('Segoe UI', 10, 'bold'), bg='#26262b', fg='#ffffff', relief='flat', padx=15, pady=8, cursor='hand2', command=pick_file)
    btn_browse.grid(row=0, column=0, padx=8)

    btn_install = tk.Button(btn_frame, text='Install Extension', font=('Segoe UI', 10, 'bold'), bg='#feca08', fg='#241a04', relief='flat', padx=18, pady=8, cursor='hand2', command=do_install)
    btn_install.grid(row=0, column=1, padx=8)

    root.mainloop()

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1].endswith('.zxp'):
        ok, msg = install_zxp(sys.argv[1])
        print(msg)
        sys.exit(0 if ok else 1)
    run_gui()
