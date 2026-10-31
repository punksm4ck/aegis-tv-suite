import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import requests
import threading

class TVTunerFinder:
    def __init__(self, root):
        self.root = root
        self.root.title("Live TV Tuner Configurator - Enterprise Edition")
        self.root.geometry("1100x800")
        self.channels = []
        self.setup_ui()
        self.load_data_thread()

    def setup_ui(self):
        style = ttk.Style()
        style.theme_use('clam')
        style.configure('TFrame', background='#e0e0e0')
        style.configure('Treeview', rowheight=25)
        style.configure('Treeview.Heading', font=('Helvetica', 10, 'bold'))

        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.pack(fill=tk.BOTH, expand=True)

        search_frame = ttk.Frame(main_frame)
        search_frame.pack(fill=tk.X, pady=(0, 10))

        ttk.Label(search_frame, text="Search Channels (e.g., News, CA, KABC):").pack(side=tk.LEFT, padx=(0, 5))
        self.search_var = tk.StringVar()
        self.search_var.trace_add('write', self.filter_channels)
        self.search_entry = ttk.Entry(search_frame, textvariable=self.search_var, width=40)
        self.search_entry.pack(side=tk.LEFT, padx=(0, 10))

        self.export_btn = ttk.Button(search_frame, text="Export Selected to M3U (Jellyfin/Plex)", command=self.export_m3u)
        self.export_btn.pack(side=tk.RIGHT)

        self.tree = ttk.Treeview(main_frame, columns=("name", "category", "url"), show="headings", selectmode="extended")
        self.tree.heading("name", text="Channel Name")
        self.tree.heading("category", text="Category / Genre")
        self.tree.heading("url", text="Stream URL (M3U8)")

        self.tree.column("name", width=300)
        self.tree.column("category", width=200)
        self.tree.column("url", width=500)

        scrollbar = ttk.Scrollbar(main_frame, orient=tk.VERTICAL, command=self.tree.yview)
        self.tree.configure(yscroll=scrollbar.set)

        self.tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        self.status_var = tk.StringVar(value="Initializing Network Request...")
        self.status_bar = ttk.Label(self.root, textvariable=self.status_var, relief=tk.SUNKEN, anchor=tk.W)
        self.status_bar.pack(side=tk.BOTTOM, fill=tk.X)

    def load_data_thread(self):
        self.status_var.set("Downloading open-source US channel database from IPTV-org...")
        threading.Thread(target=self.fetch_channels, daemon=True).start()

    def fetch_channels(self):
        try:
            response = requests.get("https://iptv-org.github.io/iptv/countries/us.m3u", timeout=15)
            response.raise_for_status()
            self.parse_m3u(response.text)
            self.root.after(0, self.update_tree, self.channels)
            self.root.after(0, lambda: self.status_var.set(f"Loaded {len(self.channels)} US channels. Select your desired local networks to export."))
        except Exception as e:
            self.root.after(0, lambda: self.status_var.set(f"Error loading channels: {str(e)}"))

    def parse_m3u(self, text):
        lines = text.splitlines()
        current_channel = {}
        for line in lines:
            line = line.strip()
            if line.startswith("#EXTINF:-1"):
                parts = line.split(",", 1)
                current_channel['name'] = parts[1].strip() if len(parts) > 1 else "Unknown Network"
                
                if 'group-title="' in line:
                    grp = line.split('group-title="')[1].split('"')[0]
                    current_channel['category'] = grp
                else:
                    current_channel['category'] = "Local / Uncategorized"
            elif line and not line.startswith("#"):
                current_channel['url'] = line
                self.channels.append(current_channel)
                current_channel = {}

    def filter_channels(self, *args):
        query = self.search_var.get().lower()
        filtered = [c for c in self.channels if query in c.get('name', '').lower() or query in c.get('category', '').lower()]
        self.update_tree(filtered)

    def update_tree(self, data):
        for item in self.tree.get_children():
            self.tree.delete(item)
        for ch in data:
            self.tree.insert("", tk.END, values=(ch.get("name", ""), ch.get("category", ""), ch.get("url", "")))

    def export_m3u(self):
        selected_items = self.tree.selection()
        if not selected_items:
            messagebox.showwarning("Export Blocked", "Please select at least one channel to export.\n\nTip: Hold Cmd (macOS) or Shift to select multiple local channels.")
            return

        filepath = filedialog.asksaveasfilename(
            defaultextension=".m3u",
            initialfile="homelab_custom_tuner.m3u",
            title="Save M3U Tuner File",
            filetypes=[("M3U Playlist", "*.m3u"), ("All Files", "*.*")]
        )
        if not filepath:
            return

        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write("#EXTM3U\n")
                for item in selected_items:
                    values = self.tree.item(item, "values")
                    name = values[0]
                    category = values[1]
                    url = values[2]
                    f.write(f'#EXTINF:-1 tvg-name="{name}" group-title="{category}",{name}\n')
                    f.write(f"{url}\n")
            
            messagebox.showinfo("Export Successful", f"Saved {len(selected_items)} custom stations to:\n{filepath}\n\nMap this file in Jellyfin's Live TV Tuner settings, or import into xTeVe for Plex.")
        except Exception as e:
            messagebox.showerror("Export Failed", str(e))

if __name__ == "__main__":
    root = tk.Tk()
    app = TVTunerFinder(root)
    root.mainloop()
