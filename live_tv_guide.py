import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import subprocess

class LiveTVGuide:
    def __init__(self, root):
        self.root = root
        self.root.title("Aegis Live TV Guide - Enterprise Edition")
        self.root.geometry("1100x700")
        self.channels = []
        self.setup_ui()

    def setup_ui(self):
        style = ttk.Style()
        style.theme_use('clam')
        style.configure('Treeview', rowheight=35, font=('Helvetica', 11))
        style.configure('Treeview.Heading', font=('Helvetica', 12, 'bold'))
        
        top_bar = ttk.Frame(self.root, padding=15)
        top_bar.pack(fill=tk.X)
        
        ttk.Button(top_bar, text="Load M3U Tuner File", command=self.load_m3u).pack(side=tk.LEFT, padx=5)
        self.now_playing = tk.StringVar(value="Status: Waiting for tuner playlist...")
        ttk.Label(top_bar, textvariable=self.now_playing, font=('Helvetica', 12, 'bold')).pack(side=tk.RIGHT, padx=5)
        
        self.tree = ttk.Treeview(self.root, columns=("name", "category"), show="headings")
        self.tree.heading("name", text="Live Network / Station")
        self.tree.heading("category", text="Category / Genre")
        self.tree.column("name", width=700)
        self.tree.column("category", width=300)
        
        scrollbar = ttk.Scrollbar(self.root, orient=tk.VERTICAL, command=self.tree.yview)
        self.tree.configure(yscroll=scrollbar.set)
        
        self.tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=15, pady=(0, 15))
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y, pady=(0, 15))
        
        self.tree.bind("<Double-1>", self.play_channel)

    def load_m3u(self):
        filepath = filedialog.askopenfilename(filetypes=[("M3U Playlist", "*.m3u"), ("All Files", "*.*")])
        if not filepath:
            return
        
        self.channels.clear()
        for item in self.tree.get_children():
            self.tree.delete(item)
            
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                lines = f.readlines()
                
            current_name = ""
            current_category = ""
            
            for line in lines:
                line = line.strip()
                if line.startswith("#EXTINF"):
                    parts = line.split(",", 1)
                    current_name = parts[1].strip() if len(parts) > 1 else "Unknown"
                    
                    if 'group-title="' in line:
                        current_category = line.split('group-title="')[1].split('"')[0]
                    else:
                        current_category = "Local"
                elif line and not line.startswith("#"):
                    self.channels.append({"name": current_name, "category": current_category, "url": line})
                    self.tree.insert("", tk.END, values=(current_name, current_category), tags=(line,))
                    
            self.now_playing.set(f"Loaded {len(self.channels)} channels. Double-click any network to tune in.")
        except Exception as e:
            messagebox.showerror("Parse Error", str(e))

    def play_channel(self, event=None):
        selected = self.tree.selection()
        if not selected:
            return
        
        item = selected[0]
        values = self.tree.item(item, "values")
        url = self.tree.item(item, "tags")[0]
        name = values[0]
        
        self.now_playing.set(f"Tuning Live: {name}...")
        
        try:
            subprocess.Popen(["open", "-a", "QuickTime Player", url])
        except Exception as e:
            messagebox.showerror("Playback Error", f"Could not launch native player: {str(e)}")

if __name__ == "__main__":
    root = tk.Tk()
    app = LiveTVGuide(root)
    root.mainloop()
