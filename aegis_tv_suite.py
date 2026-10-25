import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import requests
import threading
import platform

class UnifiedTVApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Aegis Unified Live TV Suite - Enterprise Edition")
        self.root.geometry("1400x850")
        self.available_channels_data = []
        self.setup_ui()
        self.init_player()
        self.load_data_thread()

    def init_player(self):
        try:
            import vlc
            self.vlc_instance = vlc.Instance("--no-xlib")
            self.player = self.vlc_instance.media_player_new()
            self.vlc_available = True
        except ImportError:
            self.vlc_available = False
            messagebox.showwarning("VLC Missing", "Please install VLC and run 'pip install python-vlc' for the internal player to work.")

    def setup_ui(self):
        style = ttk.Style()
        style.theme_use('clam')
        style.configure('TFrame', background='#e0e0e0')
        style.configure('Treeview', rowheight=25)
        style.configure('Treeview.Heading', font=('Helvetica', 10, 'bold'))
        
        self.notebook = ttk.Notebook(self.root)
        self.notebook.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)
        
        self.tab_config = ttk.Frame(self.notebook)
        self.notebook.add(self.tab_config, text="Tuner Configurator")
        self.setup_configurator_tab()
        
        self.tab_guide = ttk.Frame(self.notebook)
        self.notebook.add(self.tab_guide, text="Live TV Guide & Player")
        self.setup_guide_tab()
        
        self.status_var = tk.StringVar(value="Initializing Network Request...")
        self.status_bar = ttk.Label(self.root, textvariable=self.status_var, relief=tk.SUNKEN, anchor=tk.W)
        self.status_bar.pack(side=tk.BOTTOM, fill=tk.X)

    def setup_configurator_tab(self):
        top_bar = ttk.Frame(self.tab_config)
        top_bar.pack(fill=tk.X, pady=(0, 10))
        
        ttk.Label(top_bar, text="Search Available:").pack(side=tk.LEFT, padx=(0, 5))
        self.search_var = tk.StringVar()
        self.search_var.trace_add('write', self.filter_channels)
        self.search_entry = ttk.Entry(top_bar, textvariable=self.search_var, width=30)
        self.search_entry.pack(side=tk.LEFT, padx=(0, 10))
        
        self.export_btn = ttk.Button(top_bar, text="Export Queued Channels to M3U", command=self.export_m3u)
        self.export_btn.pack(side=tk.RIGHT)
        
        self.load_btn = ttk.Button(top_bar, text="Load Existing M3U", command=self.load_m3u_to_staging)
        self.load_btn.pack(side=tk.RIGHT, padx=5)
        
        content_frame = ttk.Frame(self.tab_config)
        content_frame.pack(fill=tk.BOTH, expand=True)
        content_frame.columnconfigure(0, weight=1)
        content_frame.columnconfigure(1, weight=0)
        content_frame.columnconfigure(2, weight=1)
        content_frame.rowconfigure(1, weight=1)
        
        ttk.Label(content_frame, text="Available Channels", font=('Helvetica', 10, 'bold')).grid(row=0, column=0, pady=(0, 5), sticky="w")
        ttk.Label(content_frame, text="Queued for Playlist", font=('Helvetica', 10, 'bold')).grid(row=0, column=2, pady=(0, 5), sticky="w")
        
        left_frame = ttk.Frame(content_frame)
        left_frame.grid(row=1, column=0, sticky="nsew")
        self.available_tree = self.create_treeview(left_frame)
        
        btn_frame = ttk.Frame(content_frame)
        btn_frame.grid(row=1, column=1, padx=10, sticky="n", pady=50)
        ttk.Button(btn_frame, text="Add >>", command=self.add_to_staging, width=12).pack(pady=10)
        ttk.Button(btn_frame, text="<< Remove", command=self.remove_from_staging, width=12).pack(pady=10)
        
        right_frame = ttk.Frame(content_frame)
        right_frame.grid(row=1, column=2, sticky="nsew")
        self.staging_tree = self.create_treeview(right_frame)

    def setup_guide_tab(self):
        self.guide_paned = ttk.PanedWindow(self.tab_guide, orient=tk.HORIZONTAL)
        self.guide_paned.pack(fill=tk.BOTH, expand=True)

        left_pane = ttk.Frame(self.guide_paned)
        self.guide_paned.add(left_pane, weight=1)

        right_pane = ttk.Frame(self.guide_paned)
        self.guide_paned.add(right_pane, weight=3)
        
        top_bar = ttk.Frame(left_pane)
        top_bar.pack(fill=tk.X, pady=(0, 5))
        ttk.Button(top_bar, text="Load M3U", command=self.load_guide_m3u).pack(side=tk.LEFT, padx=2)
        ttk.Button(top_bar, text="Sync Queue", command=self.sync_queue_to_guide).pack(side=tk.LEFT, padx=2)
        
        self.guide_tree = ttk.Treeview(left_pane, columns=("name", "category"), show="headings")
        self.guide_tree.heading("name", text="Station")
        self.guide_tree.heading("category", text="Genre")
        self.guide_tree.column("name", width=180)
        self.guide_tree.column("category", width=120)
        
        scrollbar = ttk.Scrollbar(left_pane, orient=tk.VERTICAL, command=self.guide_tree.yview)
        self.guide_tree.configure(yscroll=scrollbar.set)
        self.guide_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.guide_tree.bind("<Double-1>", self.play_channel)

        self.video_frame = tk.Frame(right_pane, bg="black")
        self.video_frame.pack(fill=tk.BOTH, expand=True)
        
        control_bar = ttk.Frame(right_pane)
        control_bar.pack(fill=tk.X, pady=5)
        ttk.Button(control_bar, text="Stop Playback", command=self.stop_playback).pack(side=tk.LEFT, padx=5)
        self.now_playing = tk.StringVar(value="Status: Ready")
        ttk.Label(control_bar, textvariable=self.now_playing, font=('Helvetica', 12, 'bold')).pack(side=tk.LEFT, padx=15)

    def create_treeview(self, parent_frame):
        tree = ttk.Treeview(parent_frame, columns=("name", "category", "url"), show="headings", selectmode="extended")
        tree.heading("name", text="Channel Name")
        tree.heading("category", text="Category")
        tree.heading("url", text="Stream URL")
        tree.column("name", width=200)
        tree.column("category", width=150)
        tree.column("url", width=250)
        scrollbar = ttk.Scrollbar(parent_frame, orient=tk.VERTICAL, command=tree.yview)
        tree.configure(yscroll=scrollbar.set)
        tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        return tree

    def load_data_thread(self):
        self.status_var.set("Downloading open-source US channel database from IPTV-org...")
        threading.Thread(target=self.fetch_channels, daemon=True).start()

    def fetch_channels(self):
        try:
            response = requests.get("https://iptv-org.github.io/iptv/countries/us.m3u", timeout=15)
            response.raise_for_status()
            self.parse_m3u_to_available(response.text)
            self.root.after(0, self.update_available_tree, self.available_channels_data)
            self.root.after(0, lambda: self.status_var.set(f"Loaded {len(self.available_channels_data)} US channels."))
        except Exception as e:
            self.root.after(0, lambda: self.status_var.set(f"Error loading channels: {str(e)}"))

    def parse_m3u_to_available(self, text):
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
                self.available_channels_data.append(current_channel)
                current_channel = {}

    def filter_channels(self, *args):
        query = self.search_var.get().lower()
        filtered = [c for c in self.available_channels_data if query in c.get('name', '').lower() or query in c.get('category', '').lower()]
        self.update_available_tree(filtered)

    def update_available_tree(self, data):
        for item in self.available_tree.get_children():
            self.available_tree.delete(item)
        for ch in data:
            self.available_tree.insert("", tk.END, values=(ch.get("name", ""), ch.get("category", ""), ch.get("url", "")))

    def load_m3u_to_staging(self):
        filepath = filedialog.askopenfilename(title="Select M3U Tuner File", filetypes=[("M3U", "*.m3u"), ("All", "*.*")])
        if not filepath:
            return
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            current_name = "Unknown"
            current_category = "Local"
            staged_urls = [self.staging_tree.item(i, "values")[2] for i in self.staging_tree.get_children()]
            added_count = 0
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
                    if line not in staged_urls:
                        self.staging_tree.insert("", tk.END, values=(current_name, current_category, line))
                        staged_urls.append(line)
                        added_count += 1
            messagebox.showinfo("Load Successful", f"Imported {added_count} channels into the queue.")
        except Exception as e:
            messagebox.showerror("Load Failed", str(e))

    def add_to_staging(self):
        staged_urls = [self.staging_tree.item(i, "values")[2] for i in self.staging_tree.get_children()]
        for item in self.available_tree.selection():
            vals = self.available_tree.item(item, "values")
            if vals[2] not in staged_urls:
                self.staging_tree.insert("", tk.END, values=vals)
                staged_urls.append(vals[2])

    def remove_from_staging(self):
        for item in self.staging_tree.selection():
            self.staging_tree.delete(item)

    def export_m3u(self):
        staged_items = self.staging_tree.get_children()
        if not staged_items:
            messagebox.showwarning("Export Blocked", "Your queue is empty.")
            return
        filepath = filedialog.asksaveasfilename(defaultextension=".m3u", initialfile="homelab_custom_tuner.m3u", title="Save M3U", filetypes=[("M3U", "*.m3u")])
        if not filepath:
            return
        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write("#EXTM3U\n")
                for item in staged_items:
                    values = self.staging_tree.item(item, "values")
                    name, category, url = values[0], values[1], values[2]
                    f.write(f'#EXTINF:-1 tvg-name="{name}" group-title="{category}",{name}\n')
                    f.write(f"{url}\n")
            messagebox.showinfo("Export Successful", f"Saved {len(staged_items)} stations.")
        except Exception as e:
            messagebox.showerror("Export Failed", str(e))

    def load_guide_m3u(self):
        filepath = filedialog.askopenfilename(filetypes=[("M3U Playlist", "*.m3u"), ("All Files", "*.*")])
        if not filepath:
            return
        for item in self.guide_tree.get_children():
            self.guide_tree.delete(item)
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            current_name = ""
            current_category = ""
            count = 0
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
                    self.guide_tree.insert("", tk.END, values=(current_name, current_category), tags=(line,))
                    count += 1
            self.now_playing.set(f"Loaded {count} channels.")
        except Exception as e:
            messagebox.showerror("Parse Error", str(e))

    def sync_queue_to_guide(self):
        for item in self.guide_tree.get_children():
            self.guide_tree.delete(item)
        staged_items = self.staging_tree.get_children()
        for item in staged_items:
            values = self.staging_tree.item(item, "values")
            name, category, url = values[0], values[1], values[2]
            self.guide_tree.insert("", tk.END, values=(name, category), tags=(url,))
        self.now_playing.set(f"Synced {len(staged_items)} channels from queue.")
        self.notebook.select(self.tab_guide)

    def get_window_handle(self):
        sys_os = platform.system()
        window_id = self.video_frame.winfo_id()
        if sys_os == "Windows":
            self.player.set_hwnd(window_id)
        elif sys_os == "Darwin":
            try:
                self.player.set_nsobject(window_id)
            except Exception:
                pass
        else:
            self.player.set_xwindow(window_id)

    def play_channel(self, event=None):
        if not self.vlc_available:
            messagebox.showerror("VLC Required", "python-vlc module or VLC media player is not installed on this system. Cannot play embedded video.")
            return
        selected = self.guide_tree.selection()
        if not selected:
            return
        item = selected[0]
        values = self.guide_tree.item(item, "values")
        url = self.guide_tree.item(item, "tags")[0]
        name = values[0]
        
        self.now_playing.set(f"Tuning Live: {name}")
        self.player.stop()
        
        media = self.vlc_instance.media_new(url)
        self.player.set_media(media)
        self.get_window_handle()
        self.player.play()

    def stop_playback(self):
        if self.vlc_available:
            self.player.stop()
            self.now_playing.set("Status: Stopped")

if __name__ == "__main__":
    root = tk.Tk()
    app = UnifiedTVApp(root)
    root.mainloop()
