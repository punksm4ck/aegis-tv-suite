import sys, platform, requests
from PyQt6.QtWidgets import (QApplication, QMainWindow, QWidget, QVBoxLayout,
                             QHBoxLayout, QTabWidget, QTreeWidget, QTreeWidgetItem,
                             QPushButton, QLineEdit, QLabel, QSplitter, QFileDialog, QMessageBox, QFrame)
from PyQt6.QtCore import Qt, QThread, pyqtSignal
import vlc

class DataFetcher(QThread):
    loaded = pyqtSignal(list)
    error = pyqtSignal(str)
    
    def run(self):
        try:
            r = requests.get("https://iptv-org.github.io/iptv/countries/us.m3u", timeout=15)
            r.raise_for_status()
            channels = []
            current = {}
            for line in r.text.splitlines():
                line = line.strip()
                if line.startswith("#EXTINF:-1"):
                    parts = line.split(",", 1)
                    current['name'] = parts[1].strip() if len(parts) > 1 else "Unknown"
                    current['category'] = line.split('group-title="')[1].split('"')[0] if 'group-title="' in line else "Local"
                elif line and not line.startswith("#"):
                    current['url'] = line
                    channels.append(current)
                    current = {}
            self.loaded.emit(channels)
        except Exception as e:
            self.error.emit(str(e))

class ClickableVideoFrame(QFrame):
    doubleClicked = pyqtSignal()
    def mouseDoubleClickEvent(self, event):
        self.doubleClicked.emit()
        super().mouseDoubleClickEvent(event)

class AegisTVSuite(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Aegis Unified Live TV Suite - Enterprise Edition (PyQt6)")
        self.resize(1400, 850)
        self.channels = []
        self.is_fullscreen = False
        
        self.vlc_instance = vlc.Instance("--no-xlib", "--drop-late-frames")
        self.player = self.vlc_instance.media_player_new()
        self.player.video_set_mouse_input(False)
        self.player.video_set_key_input(False)
        
        self.setup_ui()
        
        self.statusBar().showMessage("Initializing Network Request...")
        self.fetcher = DataFetcher()
        self.fetcher.loaded.connect(self.on_data_loaded)
        self.fetcher.error.connect(lambda e: self.statusBar().showMessage(f"Error: {e}"))
        self.fetcher.start()

    def setup_ui(self):
        self.tabs = QTabWidget()
        self.setCentralWidget(self.tabs)
        
        self.tab_config = QWidget()
        self.setup_config_tab()
        self.tabs.addTab(self.tab_config, "Tuner Configurator")
        
        self.tab_guide = QWidget()
        self.setup_guide_tab()
        self.tabs.addTab(self.tab_guide, "Live TV Guide & Player")

    def setup_config_tab(self):
        layout = QVBoxLayout(self.tab_config)
        
        top_bar = QHBoxLayout()
        top_bar.addWidget(QLabel("Search Available:"))
        self.search_input = QLineEdit()
        self.search_input.textChanged.connect(self.filter_channels)
        top_bar.addWidget(self.search_input)
        
        load_btn = QPushButton("Load Existing M3U")
        load_btn.clicked.connect(self.load_m3u_staging)
        top_bar.addWidget(load_btn)
        
        export_btn = QPushButton("Export Queued Channels to M3U")
        export_btn.clicked.connect(self.export_m3u)
        top_bar.addWidget(export_btn)
        layout.addLayout(top_bar)
        
        splitter = QSplitter(Qt.Orientation.Horizontal)
        
        self.tree_avail = QTreeWidget()
        self.tree_avail.setHeaderLabels(["Available Channels", "Category", "URL"])
        self.tree_avail.setSelectionMode(QTreeWidget.SelectionMode.ExtendedSelection)
        splitter.addWidget(self.tree_avail)
        
        btn_frame = QWidget()
        btn_layout = QVBoxLayout(btn_frame)
        add_btn = QPushButton("Add >>")
        add_btn.clicked.connect(self.add_to_staging)
        rem_btn = QPushButton("<< Remove")
        rem_btn.clicked.connect(self.remove_from_staging)
        btn_layout.addStretch()
        btn_layout.addWidget(add_btn)
        btn_layout.addWidget(rem_btn)
        btn_layout.addStretch()
        splitter.addWidget(btn_frame)
        
        self.tree_staged = QTreeWidget()
        self.tree_staged.setHeaderLabels(["Queued for Playlist", "Category", "URL"])
        self.tree_staged.setSelectionMode(QTreeWidget.SelectionMode.ExtendedSelection)
        splitter.addWidget(self.tree_staged)
        
        layout.addWidget(splitter)

    def setup_guide_tab(self):
        layout = QVBoxLayout(self.tab_guide)
        
        self.guide_top_widget = QWidget()
        top_bar = QHBoxLayout(self.guide_top_widget)
        top_bar.setContentsMargins(0, 0, 0, 0)
        load_guide_btn = QPushButton("Load M3U Tuner File")
        load_guide_btn.clicked.connect(self.load_guide_m3u)
        top_bar.addWidget(load_guide_btn)
        
        sync_btn = QPushButton("Sync from Configurator Queue")
        sync_btn.clicked.connect(self.sync_queue)
        top_bar.addWidget(sync_btn)
        
        self.lbl_now_playing = QLabel("Status: Ready")
        self.lbl_now_playing.setStyleSheet("font-weight: bold; font-size: 14px;")
        top_bar.addStretch()
        top_bar.addWidget(self.lbl_now_playing)
        
        stop_btn = QPushButton("Stop Playback")
        stop_btn.clicked.connect(self.stop_playback)
        top_bar.addWidget(stop_btn)
        
        layout.addWidget(self.guide_top_widget)
        
        splitter = QSplitter(Qt.Orientation.Horizontal)
        
        self.tree_guide = QTreeWidget()
        self.tree_guide.setHeaderLabels(["Station", "Genre"])
        self.tree_guide.itemDoubleClicked.connect(self.play_channel)
        splitter.addWidget(self.tree_guide)
        
        self.video_frame = ClickableVideoFrame()
        self.video_frame.setStyleSheet("background-color: black;")
        self.video_frame.doubleClicked.connect(self.toggle_fullscreen)
        splitter.addWidget(self.video_frame)
        
        splitter.setSizes([300, 900])
        layout.addWidget(splitter)

    def toggle_fullscreen(self):
        if not self.is_fullscreen:
            self.is_fullscreen = True
            self.tabs.tabBar().hide()
            self.guide_top_widget.hide()
            self.tree_guide.hide()
            self.statusBar().hide()
            self.showFullScreen()
        else:
            self.is_fullscreen = False
            self.tabs.tabBar().show()
            self.guide_top_widget.show()
            self.tree_guide.show()
            self.statusBar().show()
            self.showNormal()

    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_Escape and self.is_fullscreen:
            self.toggle_fullscreen()
        super().keyPressEvent(event)

    def on_data_loaded(self, data):
        self.channels = data
        self.update_avail_tree(data)
        self.statusBar().showMessage(f"Loaded {len(data)} US channels.")

    def update_avail_tree(self, data):
        self.tree_avail.clear()
        for ch in data:
            item = QTreeWidgetItem([ch.get('name'), ch.get('category'), ch.get('url')])
            self.tree_avail.addTopLevelItem(item)

    def filter_channels(self, text):
        query = text.lower()
        filtered = [c for c in self.channels if query in c.get('name', '').lower() or query in c.get('category', '').lower()]
        self.update_avail_tree(filtered)

    def add_to_staging(self):
        staged_urls = [self.tree_staged.topLevelItem(i).text(2) for i in range(self.tree_staged.topLevelItemCount())]
        for item in self.tree_avail.selectedItems():
            if item.text(2) not in staged_urls:
                new_item = QTreeWidgetItem([item.text(0), item.text(1), item.text(2)])
                self.tree_staged.addTopLevelItem(new_item)
                staged_urls.append(item.text(2))

    def remove_from_staging(self):
        for item in self.tree_staged.selectedItems():
            index = self.tree_staged.indexOfTopLevelItem(item)
            self.tree_staged.takeTopLevelItem(index)

    def load_m3u_staging(self):
        path, _ = QFileDialog.getOpenFileName(self, "Select M3U", "", "M3U (*.m3u);;All (*.*)")
        if path:
            self.parse_and_inject_m3u(path, self.tree_staged)

    def load_guide_m3u(self):
        path, _ = QFileDialog.getOpenFileName(self, "Select M3U", "", "M3U (*.m3u);;All (*.*)")
        if path:
            self.tree_guide.clear()
            self.parse_and_inject_m3u(path, self.tree_guide, True)

    def parse_and_inject_m3u(self, filepath, target_tree, guide_mode=False):
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            name, cat = "Unknown", "Local"
            existing = [target_tree.topLevelItem(i).text(2) for i in range(target_tree.topLevelItemCount())] if not guide_mode else []
            count = 0
            for line in lines:
                line = line.strip()
                if line.startswith("#EXTINF"):
                    parts = line.split(",", 1)
                    name = parts[1].strip() if len(parts) > 1 else "Unknown"
                    cat = line.split('group-title="')[1].split('"')[0] if 'group-title="' in line else "Local"
                elif line and not line.startswith("#"):
                    if guide_mode:
                        item = QTreeWidgetItem([name, cat])
                        item.setData(0, Qt.ItemDataRole.UserRole, line)
                        target_tree.addTopLevelItem(item)
                        count += 1
                    else:
                        if line not in existing:
                            target_tree.addTopLevelItem(QTreeWidgetItem([name, cat, line]))
                            existing.append(line)
                            count += 1
            self.statusBar().showMessage(f"Imported {count} channels.")
        except Exception as e:
            QMessageBox.critical(self, "Error", str(e))

    def export_m3u(self):
        if self.tree_staged.topLevelItemCount() == 0:
            QMessageBox.warning(self, "Warning", "Queue is empty.")
            return
        path, _ = QFileDialog.getSaveFileName(self, "Save M3U", "homelab_custom_tuner.m3u", "M3U (*.m3u)")
        if path:
            try:
                with open(path, 'w', encoding='utf-8') as f:
                    f.write("#EXTM3U\n")
                    for i in range(self.tree_staged.topLevelItemCount()):
                        item = self.tree_staged.topLevelItem(i)
                        name, cat, url = item.text(0), item.text(1), item.text(2)
                        f.write(f'#EXTINF:-1 tvg-name="{name}" group-title="{cat}",{name}\n{url}\n')
                QMessageBox.information(self, "Success", f"Saved {self.tree_staged.topLevelItemCount()} stations.")
            except Exception as e:
                QMessageBox.critical(self, "Error", str(e))

    def sync_queue(self):
        self.tree_guide.clear()
        for i in range(self.tree_staged.topLevelItemCount()):
            item = self.tree_staged.topLevelItem(i)
            new_item = QTreeWidgetItem([item.text(0), item.text(1)])
            new_item.setData(0, Qt.ItemDataRole.UserRole, item.text(2))
            self.tree_guide.addTopLevelItem(new_item)
        self.lbl_now_playing.setText("Status: Synced")

    def play_channel(self, item, column):
        url = item.data(0, Qt.ItemDataRole.UserRole)
        name = item.text(0)
        self.lbl_now_playing.setText(f"Tuning Live: {name}")
        
        self.player.stop()
        
        sys_os = platform.system()
        win_id = int(self.video_frame.winId())
        if sys_os == "Windows":
            self.player.set_hwnd(win_id)
        elif sys_os == "Darwin":
            self.player.set_nsobject(win_id)
        else:
            self.player.set_xwindow(win_id)
            
        media = self.vlc_instance.media_new(url)
        self.player.set_media(media)
        self.player.play()

    def stop_playback(self):
        self.player.stop()
        self.lbl_now_playing.setText("Status: Stopped")

if __name__ == '__main__':
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    window = AegisTVSuite()
    window.show()
    sys.exit(app.exec())
