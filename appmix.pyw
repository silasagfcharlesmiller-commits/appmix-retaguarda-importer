import sys
import os
import csv
import json
import re
import traceback
from pathlib import Path

# Mantem os arquivos gravaveis ao lado do script (ou do EXE), mesmo quando
# o VS Code inicia o programa usando outro diretorio de trabalho.
APP_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
os.chdir(APP_DIR)
from PyQt6.QtCore import Qt, QThread, pyqtSignal, QTimer, QRegularExpression
from PyQt6.QtWidgets import ( # type: ignore
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QGridLayout, QLabel, QLineEdit, QPushButton, QTableWidget, QDialog,
    QTableWidgetItem, QTextEdit, QFileDialog, QMessageBox, QFrame,
    QSplitter, QTabWidget, QDialog, QComboBox, QCheckBox, QGroupBox,
    QScrollArea, QInputDialog, QProgressBar, QHeaderView
)
from PyQt6.QtGui import QBrush, QColor, QClipboard, QIcon, QRegularExpressionValidator

from automacao_login import AutomacaoWorker
from database import DATABASE_ENGINE, DatabaseService

CONFIG_FILE = APP_DIR / "config_mix.json"
TEMPLATES_FILE = APP_DIR / "templates_retaguarda.json"


def criar_estrutura_template_zerado():
    """Retorna um template persistivel, mas sem configuracoes preenchidas."""
    campos_tabela = {
        "view_nome": "",
        "view_sql": "",
        "tmp_nome": "",
        "tmp_delete": "",
        "flag1": False,
        "flag2": False,
        "flag3": False,
        "tmp_insert": "",
        "tmp_values": "",
        "tmp_selectwhere": "",
    }
    return {
        "tabelas": {
            chave: dict(campos_tabela)
            for chave in ("pis_cofins", "icms_saida", "icms_entrada", "ibs_cbs")
        },
        "comparar_divergencia": {},
        "excecoes_produtos": {},
    }

from comparar_divergencia_widget import CompararDivergenciaWidget
class AutoResizeTextEdit(QTextEdit):
    def __init__(self, parent=None, min_h=40):
        super().__init__(parent)
        self.min_h = min_h
        self.setMinimumHeight(min_h)
        self.setLineWrapMode(QTextEdit.LineWrapMode.WidgetWidth)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.textChanged.connect(self.ajustar_altura)

    def ajustar_altura(self):
        doc = self.document()
        w = self.viewport().width()
        if w > 0:
            doc.setTextWidth(w)
        altura_ideal = int(doc.size().height() + 20)
        self.setFixedHeight(max(self.min_h, altura_ideal))

    def resizeEvent(self, e):
        super().resizeEvent(e)
        QTimer.singleShot(10, self.ajustar_altura)

    def focusInEvent(self, event):
        super().focusInEvent(event)
        if hasattr(self, 'on_focus_callback') and self.on_focus_callback:
            self.on_focus_callback(self)
        QTimer.singleShot(10, self.selectAll)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("APP MIX - Mix Fiscal")
        self.clientes_carregados = []
        self.templates_data = {}
        self.form_frames_lista = []
        self.worker_thread = None
        self.worker = None
        self.ultimo_campo_focado = None
        self.tudo_expandido = False
        self.delay_multiplier = 0.3
        self.mostrar_navegador = True
        self.database = DatabaseService()
        self.setStyleSheet("""
            QMainWindow { background-color: #e2e8f0; }
            QLabel { color: #334155; font-family: 'Segoe UI', Arial; font-size: 13px; font-weight: 500; }
            QLineEdit, QComboBox { 
                background-color: #ffffff; color: #0f172a; 
                border: 1px solid #cbd5e1; border-bottom: 2px solid #94a3b8; 
                border-radius: 6px; padding: 6px 10px; font-size: 12px; min-height: 24px; 
            }
            QLineEdit:focus, QComboBox:focus { 
                border: 1px solid #7c3aed; border-bottom: 2px solid #7c3aed; background-color: #faf5ff;
            }
            QTableWidget { 
                background-color: #ffffff; color: #0f172a; gridline-color: #e2e8f0; 
                border: 1px solid #cbd5e1; border-radius: 6px; 
            }
            QHeaderView::section { 
                background-color: #f8fafc; color: #475569; padding: 8px; border: none; 
                font-weight: bold; border-bottom: 1px solid #cbd5e1; 
            }
            QTextEdit { 
                background-color: #ffffff; color: #0f172a; border: 1px solid #cbd5e1; 
                border-bottom: 2px solid #94a3b8; border-radius: 6px; 
                font-family: 'Consolas', monospace; font-size: 11px; padding: 6px; 
            }
            QTabWidget::pane { border: 1px solid #cbd5e1; background-color: #f8fafc; border-radius: 8px; }
            QTabBar::tab { 
                background-color: #cbd5e1; color: #475569; padding: 10px 24px; 
                border-top-left-radius: 6px; border-top-right-radius: 6px; margin-right: 4px; 
                font-weight: bold; font-size: 13px; 
            }
            QTabBar::tab:selected { background-color: #7c3aed; color: white; }
            QGroupBox.card_view { 
                border: 1px solid #cbd5e1; border-radius: 8px; margin-top: 10px; 
                font-weight: bold; background-color: #ffffff; 
            }
            QGroupBox.card_view::title { 
                subcontrol-origin: margin; subcontrol-position: top left; left: 0px; right: 0px; 
                background-color: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #8b5cf6, stop:1 #6d28d9); 
                color: white; padding: 10px 14px; border-top-left-radius: 8px; border-top-right-radius: 8px; 
                font-size: 14px; font-weight: bold; text-align: center; 
            }
            QPushButton { border-radius: 6px; font-weight: bold; border: 1px solid rgba(0, 0, 0, 0.1); }
            QPushButton:pressed { margin-top: 1px; }
            QScrollArea { border: none; background: transparent; }
            QScrollBar:vertical { background: #e2e8f0; width: 18px; border-radius: 9px; }
            QScrollBar::handle:vertical { background: #94a3b8; min-height: 40px; border-radius: 9px; }
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0px; }
            QScrollBar:horizontal { background: #e2e8f0; height: 18px; border-radius: 9px; }
            QScrollBar::handle:horizontal { background: #94a3b8; min-width: 40px; border-radius: 9px; }
            QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal { width: 0px; }
            QCheckBox { color: #334155; spacing: 8px; font-size: 12px; font-weight: 500; }
            QCheckBox::indicator { width: 16px; height: 16px; border-radius: 8px; border: 1px solid #cbd5e1; background: white; }
            QCheckBox::indicator:checked { background: #7c3aed; border-color: #7c3aed; }
            
            /* Estilo customizado para QMessageBox para ficar maior e legível */
            QMessageBox { background-color: #f8fafc; min-width: 450px; min-height: 180px; }
            QMessageBox QLabel { font-size: 14px; color: #1e293b; qproperty-alignment: 'AlignVCenter'; }
            QMessageBox QPushButton { 
                background-color: #7c3aed; color: white; padding: 8px 24px; 
                font-size: 13px; border-radius: 6px; min-width: 90px; min-height: 30px; 
            }
            QMessageBox QPushButton:hover { background-color: #6d28d9; }
        """)

        self.init_ui()
        self.showMaximized()
        self.set_speed_mode("ultra")
        self.load_config()
        QTimer.singleShot(50, self.inicializacao_assincrona)

    def registrar_foco_campo(self, campo):
        self.ultimo_campo_focado = campo

    def inicializacao_assincrona(self):
        """Executa tarefas que podem falhar (como conexão de rede) após a UI ser exibida."""
        try:
            self.inicializar_banco_templates()
            self.load_templates()
        except Exception as e:
            QMessageBox.warning(self, "Aviso de Conexão",
                f"Não foi possível conectar ao banco de dados.\n\nErro: {e}\n\nOs templates não foram carregados. Verifique sua conexão com a internet e as configurações na aba 'Config Banco'.")

    def conectar_foco(self, widget):
        widget.on_focus_callback = self.registrar_foco_campo
        if isinstance(widget, QLineEdit):
            original_focus = widget.focusInEvent
            def custom_focus(event):
                original_focus(event)
                self.registrar_foco_campo(widget)
            widget.focusInEvent = custom_focus

    def inserir_variavel_cursor(self, tag):
        if not self.ultimo_campo_focado:
            QMessageBox.information(self, "Aviso", "Clique primeiro em um campo de texto (Nome da Tabela ou SQL) antes de inserir a variável!")
            return
        
        campo = self.ultimo_campo_focado
        if isinstance(campo, QLineEdit):
            campo.insert(tag)
        elif isinstance(campo, QTextEdit):
            campo.insertPlainText(tag)
        campo.setFocus()

    def init_ui(self):
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        main_layout = QVBoxLayout(central_widget)
        main_layout.setContentsMargins(12, 12, 12, 12)
        main_layout.setSpacing(8)

        self.tabs = QTabWidget()
        main_layout.addWidget(self.tabs)

        self.tab_principal = QWidget()
        self.init_tab_principal()
        self.tabs.addTab(self.tab_principal, "🚀 Automação & Lote")

        self.tab_templates = QWidget()
        self.init_tab_configuracao_geral()
        self.tabs.addTab(self.tab_templates, "📋 Configurações do Template")

        self.tab_config_banco = QWidget()
        self.init_tab_config_banco()
        self.tabs.addTab(self.tab_config_banco, "Config Banco")
    
    def init_tab_configuracao_geral(self):
        self.init_tab_templates()

    def init_tab_config_banco(self):
        layout = QVBoxLayout(self.tab_config_banco)
        layout.setContentsMargins(24, 24, 24, 24)
        layout.setSpacing(16)

        descricao = QLabel(
            "A aplicação está usando SQLite neste momento. Estes dados ficam prontos "
            "para a futura migração para PostgreSQL."
        )
        descricao.setWordWrap(True)
        descricao.setStyleSheet("color: #475569; font-size: 14px;")
        layout.addWidget(descricao)

        frame = QFrame()
        frame.setMaximumWidth(760)
        frame.setStyleSheet(
            "background-color: #ffffff; border: 1px solid #cbd5e1; "
            "border-bottom: 3px solid #cbd5e1; border-radius: 8px; padding: 18px;"
        )
        form = QGridLayout(frame)
        form.setHorizontalSpacing(14)
        form.setVerticalSpacing(12)

        self.lbl_banco_ativo = QLabel(f"Banco de dados ativo: {DATABASE_ENGINE.upper()}")
        self.lbl_banco_ativo.setStyleSheet("color: #7c3aed; font-size: 14px; font-weight: bold;")
        form.addWidget(self.lbl_banco_ativo, 0, 0, 1, 2)

        campos = [
            ("Host:", "ent_db_host", "localhost"),
            ("Porta:", "ent_db_port", "5432"),
            ("Nome do Banco:", "ent_db_name", ""),
            ("Usuário:", "ent_db_user", ""),
            ("Senha:", "ent_db_password", ""),
        ]
        for row, (label, attribute, placeholder) in enumerate(campos, start=1):
            form.addWidget(QLabel(label), row, 0)
            field = QLineEdit()
            field.setPlaceholderText(placeholder)
            if attribute == "ent_db_password":
                field.setEchoMode(QLineEdit.EchoMode.Password)
            setattr(self, attribute, field)
            form.addWidget(field, row, 1)

        botoes = QHBoxLayout()
        btn_salvar = QPushButton("Salvar configuração")
        btn_salvar.setStyleSheet("background-color: #7c3aed; color: white; padding: 9px 18px;")
        btn_salvar.clicked.connect(self.salvar_config_banco)
        botoes.addWidget(btn_salvar)

        btn_testar = QPushButton("Testar conexão")
        btn_testar.setStyleSheet("background-color: #10b981; color: white; padding: 9px 18px;")
        btn_testar.clicked.connect(self.testar_conexao_banco)
        botoes.addWidget(btn_testar)
        botoes.addStretch()
        form.addLayout(botoes, len(campos) + 1, 0, 1, 2)

        layout.addWidget(frame)
        layout.addStretch()

    def salvar_config_banco(self):
        try:
            config = {}
            if os.path.exists(CONFIG_FILE):
                with open(CONFIG_FILE, "r", encoding="utf-8") as file:
                    config = json.load(file)
            config["database"] = {
                "host": self.ent_db_host.text().strip(),
                "port": self.ent_db_port.text().strip(),
                "name": self.ent_db_name.text().strip(),
                "user": self.ent_db_user.text().strip(),
                "password": self.ent_db_password.text(),
            }
            with open(CONFIG_FILE, "w", encoding="utf-8") as file:
                json.dump(config, file, ensure_ascii=False, indent=2)
            QMessageBox.information(self, "Config Banco", "Configuração de banco salva.")
        except (OSError, json.JSONDecodeError) as erro:
            QMessageBox.critical(self, "Config Banco", f"Não foi possível salvar a configuração:\n{erro}")

    def testar_conexao_banco(self):
        try:
            self.database.test_connection()
            QMessageBox.information(
                self,
                "Config Banco",
                f"Conexão com o banco de dados PostgreSQL ({DATABASE_ENGINE.upper()}) "
                "realizada com sucesso!",
            )
        except Exception as erro:
            QMessageBox.critical(self, "Falha na Conexão", f"Não foi possível conectar ao banco de dados PostgreSQL.\n\nErro: {erro}")

    def init_tab_principal(self):
        layout_aba = QVBoxLayout(self.tab_principal)
        layout_aba.setContentsMargins(0, 0, 0, 0)
        layout_aba.setSpacing(0)

        scroll_principal = QScrollArea()
        scroll_principal.setWidgetResizable(True)

        container_conteudo = QWidget()
        container_conteudo.setMinimumWidth(1100)
        
        layout = QVBoxLayout(container_conteudo)
        layout.setSpacing(14)
        layout.setContentsMargins(16, 16, 16, 16)

        frame_cred = QFrame()
        frame_cred.setStyleSheet("background-color: #ffffff; border: 1px solid #cbd5e1; border-bottom: 3px solid #cbd5e1; border-radius: 8px; padding: 14px;")
        layout_cred = QGridLayout(frame_cred)
        layout_cred.setSpacing(12)

        layout_cred.addWidget(QLabel("Usuário Mix:"), 0, 0)
        self.ent_user = QLineEdit()
        layout_cred.addWidget(self.ent_user, 0, 1)

        layout_cred.addWidget(QLabel("Senha Mix:"), 0, 2)
        h_senha = QHBoxLayout()
        h_senha.setContentsMargins(0, 0, 0, 0)
        self.ent_pass = QLineEdit()
        self.ent_pass.setEchoMode(QLineEdit.EchoMode.Password)
        h_senha.addWidget(self.ent_pass)

        self.btn_toggle_pass = QPushButton("👁️")
        self.btn_toggle_pass.setFixedWidth(45)
        self.btn_toggle_pass.setCheckable(True)
        self.btn_toggle_pass.setStyleSheet("background-color: #e2e8f0; color: #334155; border-radius: 6px; font-weight: bold;")
        self.btn_toggle_pass.clicked.connect(self.toggle_senha)
        h_senha.addWidget(self.btn_toggle_pass)
        layout_cred.addLayout(h_senha, 0, 3)

        btn_save = QPushButton("Salvar Config")
        btn_save.setStyleSheet("background-color: #7c3aed; color: white; border-radius: 6px; padding: 8px 18px; font-weight: bold;")
        btn_save.clicked.connect(self.save_config)
        layout_cred.addWidget(btn_save, 0, 4)

        layout_cred.addWidget(QLabel("Template Ativo:"), 1, 0)
        self.combo_template_exec = QComboBox()
        self.combo_template_exec.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToContents)

        h_template_exec = QHBoxLayout()
        h_template_exec.setSpacing(6)
        h_template_exec.setContentsMargins(0,0,0,0)
        h_template_exec.addWidget(self.combo_template_exec, 1)

        btn_sync_templates = QPushButton("🔄")
        btn_sync_templates.setToolTip("Sincronizar templates do banco de dados")
        btn_sync_templates.setFixedWidth(45)
        btn_sync_templates.setStyleSheet("background-color: #e2e8f0; color: #334155; border-radius: 6px; font-weight: bold;")
        btn_sync_templates.clicked.connect(self.resync_templates)
        h_template_exec.addWidget(btn_sync_templates)
        layout_cred.addLayout(h_template_exec, 1, 1, 1, 2)
        layout.addWidget(frame_cred)

        frame_cli = QFrame()
        frame_cli.setStyleSheet("background-color: #ffffff; border: 1px solid #cbd5e1; border-bottom: 3px solid #cbd5e1; border-radius: 8px; padding: 14px;")
        layout_cli = QVBoxLayout(frame_cli)
        layout_cli.setSpacing(12)
        layout.addWidget(frame_cli)

        h_cli = QHBoxLayout()
        btn_csv = QPushButton("📁 Importar Planilha CSV")
        btn_csv.setStyleSheet("background-color: #7c3aed; color: white; border-radius: 6px; padding: 10px 18px; font-weight: bold;")
        btn_csv.clicked.connect(self.importar_csv)
        h_cli.addWidget(btn_csv)

        btn_colar = QPushButton("📋 Colar Lista (CNPJ)")
        btn_colar.setStyleSheet("background-color: #7c3aed; color: white; border-radius: 6px; padding: 10px 18px; font-weight: bold;")
        btn_colar.clicked.connect(self.colar_dados_dialogo)
        h_cli.addWidget(btn_colar)

        btn_limpar_grid = QPushButton("🗑 Limpar grid")
        btn_limpar_grid.setToolTip("Remove todos os CNPJs carregados na fila")
        btn_limpar_grid.setStyleSheet(
            "background-color: #fff1f2; color: #be123c; border: 1px solid #fda4af; "
            "border-radius: 6px; padding: 10px 18px; font-weight: bold;"
        )
        btn_limpar_grid.clicked.connect(self.limpar_grid_clientes)
        h_cli.addWidget(btn_limpar_grid)

        self.lbl_status_csv = QLabel("Nenhum cliente carregado na fila.")
        self.lbl_status_csv.setStyleSheet("color: #7c3aed; font-weight: bold; font-size: 13px;")

        self.chk_mostrar_navegador = QCheckBox("Mostrar navegador")
        self.chk_mostrar_navegador.setChecked(True)
        self.chk_mostrar_navegador.setStyleSheet("color: #334155; font-weight: bold;")

        self.btn_speed_normal = QPushButton("Normal")
        self.btn_speed_normal.setStyleSheet("background-color: #0ea5e9; color: white; border-radius: 6px; padding: 8px 14px; font-weight: bold;")
        self.btn_speed_normal.clicked.connect(lambda: self.set_speed_mode("normal"))

        self.btn_speed_rapida = QPushButton("Rápida")
        self.btn_speed_rapida.setStyleSheet("background-color: #14b8a6; color: white; border-radius: 6px; padding: 8px 14px; font-weight: bold;")
        self.btn_speed_rapida.clicked.connect(lambda: self.set_speed_mode("rapida"))

        self.btn_speed_ultra = QPushButton("Ultra")
        self.btn_speed_ultra.setStyleSheet("background-color: #f97316; color: white; border-radius: 6px; padding: 8px 14px; font-weight: bold;")
        self.btn_speed_ultra.clicked.connect(lambda: self.set_speed_mode("ultra"))

        self.lbl_speed = QLabel("Velocidade: Normal")
        self.lbl_speed.setStyleSheet("color: #334155; font-weight: bold; font-size: 13px;")

        self.btn_pause = QPushButton("Pausar")
        self.btn_pause.setStyleSheet("background-color: #f59e0b; color: white; border-radius: 6px; padding: 8px 14px; font-weight: bold;")
        self.btn_pause.clicked.connect(self.pausar_automacao)
        self.btn_pause.setEnabled(False)

        self.btn_resume = QPushButton("Continuar")
        self.btn_resume.setStyleSheet("background-color: #10b981; color: white; border-radius: 6px; padding: 8px 14px; font-weight: bold;")
        self.btn_resume.clicked.connect(self.continuar_automacao)
        self.btn_resume.setEnabled(False)

        h_cli.addWidget(self.lbl_status_csv)
        h_cli.addWidget(self.chk_mostrar_navegador)
        h_cli.addWidget(self.btn_speed_normal)
        h_cli.addWidget(self.btn_speed_rapida)
        h_cli.addWidget(self.btn_speed_ultra)
        h_cli.addWidget(self.lbl_speed)
        h_cli.addWidget(self.btn_pause)
        h_cli.addWidget(self.btn_resume)

        h_cli.addStretch()
        layout_cli.addLayout(h_cli)

        splitter = QSplitter(Qt.Orientation.Vertical)
        splitter.setHandleWidth(6)
        
        self.table_clientes = QTableWidget(0, 2)
        self.table_clientes.setHorizontalHeaderLabels(["CNPJ do Cliente", "Status"])
        self.table_clientes.horizontalHeader().setStretchLastSection(True)
        self.table_clientes.setColumnWidth(0, 330)
        self.table_clientes.verticalHeader().setVisible(False)
        self.table_clientes.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.table_clientes.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table_clientes.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.table_clientes.setMinimumHeight(280)
        # Até 10 linhas a grade cresce; acima disso a barra de rolagem aparece.
        self.table_clientes.setMaximumHeight(390)
        self.table_clientes.verticalHeader().setDefaultSectionSize(32)
        splitter.addWidget(self.table_clientes)

        self.console = QTextEdit()
        self.console.setReadOnly(True)
        self.console.setMinimumHeight(260)
        self.console.setStyleSheet(
            "background-color: #0f172a; color: #e2e8f0; border: 1px solid #334155; "
            "border-radius: 8px; padding: 10px; font-family: Consolas, 'Courier New', monospace; "
            "font-size: 14px; line-height: 1.45;"
        )
        self.console.setPlaceholderText("Os eventos da automação serão exibidos aqui...")
        splitter.addWidget(self.console)
        
        splitter.setSizes([360, 310])
        layout_cli.addWidget(splitter)

        self.progress_bar = QProgressBar()
        self.progress_bar.setMinimum(0)
        self.progress_bar.setValue(0)
        self.progress_bar.setFixedHeight(50)
        self.progress_bar.setStyleSheet("QProgressBar { border-radius: 10px; text-align: center; font-weight: bold; } QProgressBar::chunk { border-radius: 10px; background-color: #22c55e; }")
        self.progress_bar.setFormat("Progresso: %p%")
        self.progress_bar.setTextVisible(True)
        layout_cli.addWidget(self.progress_bar)

        self.btn_executar = QPushButton("🚀 Iniciar Automação (Login & Tabelas)")
        self.btn_executar.setStyleSheet("background-color: #10b981; color: white; border-radius: 8px; font-size: 16px; padding: 16px; font-weight: bold;")
        self.btn_executar.setMinimumHeight(55)
        self.btn_executar.clicked.connect(self.iniciar_automacao)
        layout.addWidget(self.btn_executar)
        
        layout.addStretch()
        scroll_principal.setWidget(container_conteudo)
        layout_aba.addWidget(scroll_principal)

    def init_tab_templates(self):
        layout = QVBoxLayout(self.tab_templates)
        layout.setSpacing(8)
        layout.setContentsMargins(10, 10, 10, 10)

        top_frame = QFrame()
        top_frame.setStyleSheet("background-color: #ffffff; border: 1px solid #cbd5e1; border-bottom: 3px solid #cbd5e1; border-radius: 8px; padding: 10px;")
        top_layout = QVBoxLayout(top_frame)
        top_layout.setSpacing(10)

        # --- LINHA 1: Gerenciamento de Templates com Destaque Visual no Ativo ---
        row1 = QHBoxLayout()
        row1.setSpacing(10)
        
        row1.addWidget(QLabel("<b>Template Atual:</b>"))
        self.combo_retaguarda = QComboBox()
        self.combo_retaguarda.setMinimumWidth(220)
        # Deixando o ComboBox do editor com destaque chamativo (borda roxa grossa e fundo suave)
        self.combo_retaguarda.setStyleSheet("""
            QComboBox {
                background-color: #f5f3ff;
                color: #5b21b6;
                border: 2px solid #7c3aed;
                border-bottom: 3px solid #6d28d9;
                font-weight: bold;
                font-size: 13px;
                padding: 6px 10px;
                border-radius: 6px;
            }
            QComboBox::drop-down { border: 0px; }
            QComboBox QAbstractItemView {
                background-color: #ffffff;
                color: #1e293b;
                selection-background-color: #7c3aed;
                selection-color: white;
                font-weight: bold;
            }
        """)
        self.combo_retaguarda.currentIndexChanged.connect(self.carregar_template_na_tela)
        row1.addWidget(self.combo_retaguarda)

        btn_novo_template = QPushButton("➕ Criar Novo Template")
        btn_novo_template.setStyleSheet("background-color: #0284c7; color: white; border-radius: 6px; padding: 8px 14px; font-weight: bold;")
        btn_novo_template.clicked.connect(self.criar_novo_template)
        row1.addWidget(btn_novo_template)

        btn_excluir_template = QPushButton("🗑️ Excluir Template")
        btn_excluir_template.setStyleSheet("background-color: #ef4444; color: white; border-radius: 6px; padding: 8px 14px; font-weight: bold;")
        btn_excluir_template.clicked.connect(self.excluir_template_atual)
        row1.addWidget(btn_excluir_template)
        row1.addStretch()
        top_layout.addLayout(row1)

        # --- LINHA 2: Atalhos de Variáveis (Cores mais suaves e harmoniosas) e Botão Expandir ---
        row2 = QHBoxLayout()
        row2.setSpacing(10)

        row2.addWidget(QLabel("<b>Atalhos de Inserção:</b>"))
        
        btn_var_estado = QPushButton("➕ Inserir Estado (SP)")
        btn_var_estado.setStyleSheet("background-color: #8b5cf6; color: white; border-radius: 6px; padding: 7px 12px; font-weight: bold;")
        btn_var_estado.clicked.connect(lambda: self.inserir_variavel_cursor("{estado}"))
        row2.addWidget(btn_var_estado)

        btn_var_cnpj = QPushButton("➕ Inserir CNPJ ")
        btn_var_cnpj.setStyleSheet("background-color: #8b5cf6; color: white; border-radius: 6px; padding: 7px 12px; font-weight: bold;")
        btn_var_cnpj.clicked.connect(lambda: self.inserir_variavel_cursor("{cnpj}"))
        row2.addWidget(btn_var_cnpj)

        btn_var_regime = QPushButton("➕ Inserir Regime Tributário")
        btn_var_regime.setStyleSheet("background-color: #8b5cf6; color: white; border-radius: 6px; padding: 7px 12px; font-weight: bold;")
        btn_var_regime.clicked.connect(lambda: self.inserir_variavel_cursor("{regime_tributario}"))
        row2.addWidget(btn_var_regime)

        btn_var_empresa = QPushButton("➕ Inserir Nome Empresa")
        btn_var_empresa.setStyleSheet("background-color: #8b5cf6; color: white; border-radius: 6px; padding: 7px 12px; font-weight: bold;")
        btn_var_empresa.clicked.connect(lambda: self.inserir_variavel_cursor("{nome_empresa}"))
        row2.addWidget(btn_var_empresa)

        row2.addSpacing(30)

        self.btn_toggle_expandir = QPushButton("📂 Expandir Tudo")
        self.btn_toggle_expandir.setStyleSheet("background-color: #7c3aed; color: white; border-radius: 6px; padding: 7px 16px; font-weight: bold;")
        self.btn_toggle_expandir.clicked.connect(self.alternar_expandir_recolher)
        row2.addWidget(self.btn_toggle_expandir)

        row2.addStretch()
        top_layout.addLayout(row2)

        layout.addWidget(top_frame)

        self.lbl_toast = QLabel("📋 Tabela copiada!", self.tab_templates)
        self.lbl_toast.setStyleSheet("background-color: #0f172a; color: white; padding: 8px 16px; border-radius: 6px; font-weight: bold; font-size: 13px;")
        self.lbl_toast.hide()

        scroll_area = QScrollArea()
        scroll_area.setWidgetResizable(True)
        layout.addWidget(scroll_area)

        # Container para todo o conteúdo rolável
        scroll_content_widget = QWidget()
        scroll_area.setWidget(scroll_content_widget)
        scroll_layout = QVBoxLayout(scroll_content_widget)
        scroll_layout.setContentsMargins(0, 0, 0, 0)
        scroll_layout.setSpacing(12)

        # Layout horizontal para as colunas VIEW e TMP
        tabelas_layout = QHBoxLayout()
        tabelas_layout.setSpacing(12)

        self.inputs_tributos = {}
        tributos_info = [
            ("PIS E COFINS", "pis_cofins"), ("ICMS SAIDA", "icms_saida"),
            ("ICMS ENTRADA", "icms_entrada"), ("IBS E CBS", "ibs_cbs")
        ]

        # Coluna VIEW
        gb_view_main = QGroupBox("Tabelas VIEW")
        gb_view_main.setProperty("class", "card_view")
        layout_view_card = QVBoxLayout(gb_view_main)
        layout_view_card.setContentsMargins(8, 32, 8, 8)
        layout_view_card.setSpacing(8)

        for nome_tributo, chave in tributos_info:
            self.inputs_tributos[chave] = {}
            # ... (código de criação dos widgets da VIEW, sem alterações)
            container_trib = QWidget()
            v_cont = QVBoxLayout(container_trib)
            v_cont.setContentsMargins(0, 0, 0, 0)
            v_cont.setSpacing(4)

            row_frame = QFrame()
            row_frame.setStyleSheet("background-color: #ffffff; border: 1px solid #cbd5e1; border-bottom: 2px solid #94a3b8; border-radius: 6px; padding: 4px;")
            h_row = QHBoxLayout(row_frame)
            h_row.setContentsMargins(6, 4, 6, 4)
            
            btn_edit = QPushButton("✏️ Editar")
            btn_edit.setFixedHeight(26)
            btn_edit.setStyleSheet("background-color: #ede9fe; color: #7c3aed; border-radius: 4px; font-weight: bold; padding: 0 8px; border: none;")
            
            lbl_nome = QLabel(nome_tributo)
            lbl_nome.setStyleSheet("color: #7c3aed; font-weight: bold; background: transparent; border: none;")
            lbl_val = QLabel("...")
            lbl_val.setStyleSheet("color: #475569; background: transparent; border: none;")

            btn_copy = QPushButton("📋")
            btn_copy.setFixedSize(26, 26)
            btn_copy.setStyleSheet("background-color: #f1f5f9; color: #334155; border-radius: 4px; border: 1px solid #cbd5e1;")
            btn_copy.clicked.connect(lambda checked, l=lbl_val: self.copiar_texto_com_aviso(l.text()))

            h_row.addWidget(btn_edit)
            h_row.addWidget(lbl_nome)
            h_row.addStretch()
            h_row.addWidget(lbl_val)
            h_row.addWidget(btn_copy)
            v_cont.addWidget(row_frame)

            form_frame = QFrame()
            form_frame.setStyleSheet("background-color: #ffffff; border: none; padding: 4px; margin-top: 2px;")
            v_form = QVBoxLayout(form_frame)
            v_form.setContentsMargins(0, 0, 0, 0)
            v_form.setSpacing(6)

            v_form.addWidget(QLabel("Nome da tabela"))
            txt_vn = QLineEdit()
            txt_vn.setStyleSheet("background-color: #ffffff; border: 1px solid #cbd5e1; border-radius: 4px; padding: 4px;")
            txt_vn.textChanged.connect(lambda text, l=lbl_val: l.setText(text if text else "..."))
            self.conectar_foco(txt_vn)
            v_form.addWidget(txt_vn)

            v_form.addWidget(QLabel("SELECT de Consulta View" if chave != "ibs_cbs" else "SELECT IBS E CBS tabela"))
            txt_vs = AutoResizeTextEdit(min_h=60)
            txt_vs.setStyleSheet("background-color: #ffffff; border: 1px solid #cbd5e1; border-radius: 4px; padding: 4px; font-family: 'Consolas', monospace;")
            self.conectar_foco(txt_vs)
            v_form.addWidget(txt_vs)

            hb = QHBoxLayout()
            bs = QPushButton("Salvar Seção")
            bs.setStyleSheet("background-color: #7c3aed; color: white; border-radius: 6px; padding: 5px 12px; font-weight: bold;")
            bs.clicked.connect(self.salvar_template_atual)
            bc = QPushButton("Fechar")
            bc.setStyleSheet("background-color: #64748b; color: white; border-radius: 6px; padding: 5px 12px; font-weight: bold;")
            hb.addWidget(bs)
            hb.addWidget(bc)
            hb.addStretch()
            v_form.addLayout(hb)

            form_frame.hide()
            v_cont.addWidget(form_frame)
            self.form_frames_lista.append(form_frame)

            btn_edit.clicked.connect(lambda checked, f=form_frame: [f.setVisible(not f.isVisible()), QTimer.singleShot(20, txt_vs.ajustar_altura)])
            bc.clicked.connect(lambda checked, f=form_frame: f.hide())
            layout_view_card.addWidget(container_trib)

            self.inputs_tributos[chave]["view_nome"] = txt_vn
            self.inputs_tributos[chave]["view_sql"] = txt_vs
            self.inputs_tributos[chave]["view_label_valor"] = lbl_val
        layout_view_card.addStretch()
        tabelas_layout.addWidget(gb_view_main, 1)

        # Coluna TMP
        gb_tmp_main = QGroupBox("Tabelas TMP")
        gb_tmp_main.setProperty("class", "card_view")
        layout_tmp_card = QVBoxLayout(gb_tmp_main)
        layout_tmp_card.setContentsMargins(8, 32, 8, 8)
        layout_tmp_card.setSpacing(8)

        for nome_tributo, chave in tributos_info:
            # ... (código de criação dos widgets da TMP, sem alterações)
            container_trib_t = QWidget()
            v_cont_t = QVBoxLayout(container_trib_t)
            v_cont_t.setContentsMargins(0, 0, 0, 0)
            v_cont_t.setSpacing(4)

            row_frame_t = QFrame()
            row_frame_t.setStyleSheet("background-color: #ffffff; border: 1px solid #cbd5e1; border-bottom: 2px solid #94a3b8; border-radius: 6px; padding: 4px;")
            h_row_t = QHBoxLayout(row_frame_t)
            h_row_t.setContentsMargins(6, 4, 6, 4)
            
            btn_edit_t = QPushButton("✏️ Editar")
            btn_edit_t.setFixedHeight(26)
            btn_edit_t.setStyleSheet("background-color: #ede9fe; color: #7c3aed; border-radius: 4px; font-weight: bold; padding: 0 8px; border: none;")
            
            lbl_nome_t = QLabel(nome_tributo)
            lbl_nome_t.setStyleSheet("color: #7c3aed; font-weight: bold; background: transparent; border: none;")
            lbl_val_t = QLabel("...")
            lbl_val_t.setStyleSheet("color: #475569; background: transparent; border: none;")

            btn_copy_t = QPushButton("📋")
            btn_copy_t.setFixedSize(26, 26)
            btn_copy_t.setStyleSheet("background-color: #f1f5f9; color: #334155; border-radius: 4px; border: 1px solid #cbd5e1;")
            btn_copy_t.clicked.connect(lambda checked, l=lbl_val_t: self.copiar_texto_com_aviso(l.text()))

            h_row_t.addWidget(btn_edit_t)
            h_row_t.addWidget(lbl_nome_t)
            h_row_t.addStretch()
            h_row_t.addWidget(lbl_val_t)
            h_row_t.addWidget(btn_copy_t)
            v_cont_t.addWidget(row_frame_t)

            form_frame_t = QFrame()
            form_frame_t.setStyleSheet("background-color: #ffffff; border: none; padding: 4px; margin-top: 2px;")
            v_form_t = QVBoxLayout(form_frame_t)
            v_form_t.setContentsMargins(0, 0, 0, 0)
            v_form_t.setSpacing(6)

            txt_tn = QLineEdit()
            txt_tn.setStyleSheet("background-color: #ffffff; border: 1px solid #cbd5e1; border-radius: 4px; padding: 4px;")
            txt_tn.textChanged.connect(lambda text, l=lbl_val_t: l.setText(text if text else "..."))
            self.conectar_foco(txt_tn)
            v_form_t.addWidget(QLabel("Nome da tabela TMP"))
            v_form_t.addWidget(txt_tn)

            txt_td = AutoResizeTextEdit(min_h=45)
            txt_td.setStyleSheet("background-color: #ffffff; border: 1px solid #cbd5e1; border-radius: 4px; padding: 4px; font-family: 'Consolas', monospace;")
            self.conectar_foco(txt_td)
            v_form_t.addWidget(QLabel("SELECT Delete para todos os itens"))
            v_form_t.addWidget(txt_td)

            chk_f1 = QCheckBox(f"Zerar TMP {nome_tributo} antes de Sincronizar?")
            chk_f1.setChecked(True)
            v_form_t.addWidget(chk_f1)
            chk_f2 = QCheckBox(f"Gravar {nome_tributo} apenas aprovados?")
            v_form_t.addWidget(chk_f2)
            chk_f3 = QCheckBox(f"Gravar {nome_tributo} todos produtos classificados?")
            v_form_t.addWidget(chk_f3)

            txt_ti = AutoResizeTextEdit(min_h=80)
            txt_ti.setStyleSheet("background-color: #ffffff; border: 1px solid #cbd5e1; border-radius: 4px; padding: 4px; font-family: 'Consolas', monospace;")
            self.conectar_foco(txt_ti)
            v_form_t.addWidget(QLabel("SQL Insert na tabela temporária"))
            v_form_t.addWidget(txt_ti)

            txt_tv = AutoResizeTextEdit(min_h=80)
            txt_tv.setStyleSheet("background-color: #ffffff; border: 1px solid #cbd5e1; border-radius: 4px; padding: 4px; font-family: 'Consolas', monospace;")
            self.conectar_foco(txt_tv)
            v_form_t.addWidget(QLabel("VALUES ("))
            v_form_t.addWidget(txt_tv)

            txt_ts = AutoResizeTextEdit(min_h=50)
            txt_ts.setStyleSheet("background-color: #ffffff; border: 1px solid #cbd5e1; border-radius: 4px; padding: 4px; font-family: 'Consolas', monospace;")
            self.conectar_foco(txt_ts)
            v_form_t.addWidget(QLabel("SELECT * FROM WHERE"))
            v_form_t.addWidget(txt_ts)

            hb_t = QHBoxLayout()
            bs_t = QPushButton("Salvar Seção")
            bs_t.setStyleSheet("background-color: #7c3aed; color: white; border-radius: 6px; padding: 5px 12px; font-weight: bold;")
            bs_t.clicked.connect(self.salvar_template_atual)
            bc_t = QPushButton("Fechar")
            bc_t.setStyleSheet("background-color: #64748b; color: white; border-radius: 6px; padding: 5px 12px; font-weight: bold;")
            hb_t.addWidget(bs_t)
            hb_t.addWidget(bc_t)
            hb_t.addStretch()
            v_form_t.addLayout(hb_t)

            form_frame_t.hide()
            v_cont_t.addWidget(form_frame_t)
            self.form_frames_lista.append(form_frame_t)

            btn_edit_t.clicked.connect(lambda checked, f=form_frame_t, edits=[txt_td, txt_ti, txt_tv, txt_ts]: [f.setVisible(not f.isVisible()), [QTimer.singleShot(20, ed.ajustar_altura) for ed in edits]])
            bc_t.clicked.connect(lambda checked, f=form_frame_t: f.hide())
            layout_tmp_card.addWidget(container_trib_t)

            self.inputs_tributos[chave].update({
                "tmp_nome": txt_tn, "tmp_delete": txt_td, "flag1": chk_f1,
                "flag2": chk_f2, "flag3": chk_f3, "tmp_insert": txt_ti,
                "tmp_values": txt_tv, "tmp_selectwhere": txt_ts,
                "tmp_label_valor": lbl_val_t
            })
        layout_tmp_card.addStretch()
        tabelas_layout.addWidget(gb_tmp_main, 1)
        scroll_layout.addLayout(tabelas_layout)

        # Seção Colapsável para Comparar Divergência
        self.widget_divergencia = CompararDivergenciaWidget()
        self.widget_divergencia.setVisible(False) # Começa recolhido

        btn_toggle_divergencia = QPushButton("Configuração - Comparar Divergência (Clique para expandir/recolher)")
        btn_toggle_divergencia.setStyleSheet("""
            QPushButton {
                background-color: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #8b5cf6, stop:1 #6d28d9);
                color: white; padding: 10px 14px; border-radius: 8px;
                font-size: 14px; font-weight: bold; text-align: center;
                border: 1px solid #6d28d9;
            }
        """)
        btn_toggle_divergencia.clicked.connect(lambda: self.widget_divergencia.setVisible(not self.widget_divergencia.isVisible()))

        scroll_layout.addWidget(btn_toggle_divergencia)

        # Botão Salvar agora fica dentro da seção de divergência
        btn_salvar_template = QPushButton("💾 Salvar Todas as Alterações do Template")
        btn_salvar_template.setStyleSheet("background-color: #10b981; color: white; border-radius: 8px; padding: 12px 18px; font-weight: bold; font-size: 14px; margin-top: 10px;")
        btn_salvar_template.clicked.connect(self.salvar_template_atual)
        
        # Adiciona o botão dentro do widget de divergência para que ele expanda/recolha junto
        self.widget_divergencia.layout().addWidget(btn_salvar_template)
        scroll_layout.addWidget(self.widget_divergencia)
        scroll_layout.addStretch()

    def alternar_expandir_recolher(self):
        if not self.tudo_expandido:
            for f in self.form_frames_lista:
                f.show()
            self.btn_toggle_expandir.setText("📁 Recolher Tudo")
            self.btn_toggle_expandir.setStyleSheet("background-color: #64748b; color: white; border-radius: 6px; padding: 7px 16px; font-weight: bold;")
            self.tudo_expandido = True
        else:
            for f in self.form_frames_lista:
                f.hide()
            self.btn_toggle_expandir.setText("📂 Expandir Tudo")
            self.btn_toggle_expandir.setStyleSheet("background-color: #7c3aed; color: white; border-radius: 6px; padding: 7px 16px; font-weight: bold;")
            self.tudo_expandido = False

    def criar_novo_template(self):
        nome_novo, ok = QInputDialog.getText(self, "Novo Template", "Digite o nome da nova retaguarda (ex: Totvs, Millennium):")
        if not ok or not nome_novo.strip():
            return
        
        nome_novo = nome_novo.strip()
        if nome_novo in self.templates_data:
            QMessageBox.warning(self, "Aviso", f"O template '{nome_novo}' já existe!")
            return

        msg_box = QMessageBox(self)
        msg_box.setWindowTitle("Base para o Template")
        msg_box.setText("Deseja copiar as configurações do template atual para editar por cima?\n(Clique em 'Não' para começar um template totalmente zerado)")
        btn_sim = msg_box.addButton("Sim", QMessageBox.ButtonRole.YesRole)
        btn_nao = msg_box.addButton("Não", QMessageBox.ButtonRole.NoRole)
        msg_box.exec()

        if msg_box.clickedButton() == btn_sim and self.combo_retaguarda.currentText() in self.templates_data:
            self.templates_data[nome_novo] = json.loads(json.dumps(self.templates_data[self.combo_retaguarda.currentText()]))
        else:
            # Criação completamente vazia e zerada
            self.templates_data[nome_novo] = criar_estrutura_template_zerado()

        self.salvar_template_no_banco(nome_novo, self.templates_data[nome_novo])

        self.load_templates()
        index = self.combo_retaguarda.findText(nome_novo)
        if index >= 0:
            self.combo_retaguarda.setCurrentIndex(index)
        
        QMessageBox.information(self, "Sucesso", f"Template '{nome_novo}' criado com sucesso! Agora é só preencher e clicar em 'Salvar Alterações'.")

    def copiar_texto_com_aviso(self, texto):
        QApplication.clipboard().setText(texto)
        self.lbl_toast.show()
        self.lbl_toast.raise_()
        self.lbl_toast.move(int((self.tab_templates.width() - self.lbl_toast.width()) / 2), self.tab_templates.height() - 60)
        QTimer.singleShot(1500, self.lbl_toast.hide)

    def toggle_senha(self, checked):
        if checked:
            self.ent_pass.setEchoMode(QLineEdit.EchoMode.Normal)
            self.btn_toggle_pass.setText("🔒")
        else:
            self.ent_pass.setEchoMode(QLineEdit.EchoMode.Password)
            self.btn_toggle_pass.setText("👁️")

    def log(self, msg):
        self.console.append(msg)

    def save_config(self):
        config = {}
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as file:
                    config = json.load(file)
            except (OSError, json.JSONDecodeError):
                pass
        config.update({"user": self.ent_user.text().strip(), "pass": self.ent_pass.text().strip()})
        with open(CONFIG_FILE, "w", encoding="utf-8") as file:
            json.dump(config, file, ensure_ascii=False, indent=2)
        QMessageBox.information(self, "Sucesso", "Configurações salvas!")

    def load_config(self):
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r") as f:
                    cfg = json.load(f)
                    self.ent_user.setText(cfg.get("user", ""))
                    self.ent_pass.setText(cfg.get("pass", ""))
                    database_config = cfg.get("database", {})
                    self.ent_db_host.setText(database_config.get("host", ""))
                    self.ent_db_port.setText(database_config.get("port", ""))
                    self.ent_db_name.setText(database_config.get("name", ""))
                    self.ent_db_user.setText(database_config.get("user", ""))
                    self.ent_db_password.setText(database_config.get("password", ""))
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Repositório local de templates (SQLite)
    # ------------------------------------------------------------------
    def inicializar_banco_templates(self):
        """
        Cria o esquema do banco de dados se ele não existir.
        Levanta uma exceção em caso de falha de conexão, que será tratada
        pela `inicializacao_assincrona`.
        """
        self.database.initialize_templates(TEMPLATES_FILE)
        self.lbl_banco_ativo.setText(f"Banco de dados ativo: {DATABASE_ENGINE.upper()}")

    def carregar_templates_do_banco(self):
        return self.database.load_templates()

    def salvar_template_no_banco(self, nome, dados):
        self.database.save_template(nome, dados)

    def excluir_template_do_banco(self, nome):
        self.database.delete_template(nome)

    def resync_templates(self):
        """Tenta recarregar os templates do banco de dados, mostrando feedback visual."""
        self.log("🔄 Sincronizando templates do banco de dados...")
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            self.load_templates(show_success=True)
        finally:
            QApplication.restoreOverrideCursor()

    def load_templates(self, show_success: bool = False):
        try:
            self.templates_data = self.carregar_templates_do_banco()
            if show_success:
                QMessageBox.information(self, "Sucesso", "Templates sincronizados com sucesso!")
        except Exception as erro:
            self.templates_data = {}
            QMessageBox.warning(self, "Erro de Sincronização", f"Não foi possível carregar os templates do banco de dados:\n\n{str(erro)}")
        
        lista_templates = list(self.templates_data.keys()) if self.templates_data else []

        # Bloqueia os sinais para evitar que a mudança de itens dispare o evento de seleção
        self.combo_retaguarda.blockSignals(True)
        self.combo_template_exec.blockSignals(True)

        # Salva a seleção atual para tentar restaurá-la depois
        selecao_retaguarda_atual = self.combo_retaguarda.currentText()
        selecao_exec_atual = self.combo_template_exec.currentText()

        # Limpa e repopula as listas
        self.combo_retaguarda.clear()
        self.combo_template_exec.clear()
        self.combo_retaguarda.addItems(lista_templates)
        self.combo_template_exec.addItems(lista_templates)

        # Tenta restaurar a seleção anterior. Se não encontrar, seleciona o primeiro item.
        idx_retaguarda = self.combo_retaguarda.findText(selecao_retaguarda_atual)
        self.combo_retaguarda.setCurrentIndex(idx_retaguarda if idx_retaguarda != -1 else 0)
        
        idx_exec = self.combo_template_exec.findText(selecao_exec_atual)
        self.combo_template_exec.setCurrentIndex(idx_exec if idx_exec != -1 else 0)

        # Desbloqueia os sinais ANTES de forçar a atualização da tela
        self.combo_retaguarda.blockSignals(False)
        self.combo_template_exec.blockSignals(False)
        
        self.carregar_template_na_tela() # Força a atualização com o item que ficou selecionado

    def adicionar_linha_excecao(self, cnpj="", codigos=None, ativo=True):
        """Adiciona uma linha simples mantendo o formato interno já utilizado."""
        linha = self.tabela_excecoes.rowCount()
        self.tabela_excecoes.insertRow(linha)
        campo_cnpj = QLineEdit()
        campo_cnpj.setPlaceholderText("Somente 14 números")
        campo_cnpj.setMaxLength(14)
        campo_cnpj.setValidator(
            QRegularExpressionValidator(QRegularExpression(r"\d{0,14}"), campo_cnpj)
        )
        campo_cnpj.setText(re.sub(r"\D", "", str(cnpj))[:14])
        self.tabela_excecoes.setCellWidget(linha, 0, campo_cnpj)
        texto_codigos = ", ".join(str(codigo) for codigo in (codigos or []))
        self.tabela_excecoes.setItem(linha, 1, QTableWidgetItem(texto_codigos))
        chk_ativo = QCheckBox()
        chk_ativo.setChecked(bool(ativo))
        chk_ativo.setToolTip("Desmarque para não aplicar estes códigos")
        container_ativo = QWidget()
        layout_ativo = QHBoxLayout(container_ativo)
        layout_ativo.setContentsMargins(0, 0, 0, 0)
        layout_ativo.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout_ativo.addWidget(chk_ativo)
        self.tabela_excecoes.setCellWidget(linha, 2, container_ativo)
        self.tabela_excecoes.setCurrentCell(linha, 0)
        campo_cnpj.setFocus()

    def remover_linhas_excecao(self):
        linhas = sorted(
            {indice.row() for indice in self.tabela_excecoes.selectedIndexes()},
            reverse=True,
        )
        if not linhas and self.tabela_excecoes.currentRow() >= 0:
            linhas = [self.tabela_excecoes.currentRow()]
        for linha in linhas:
            self.tabela_excecoes.removeRow(linha)

    def coletar_excecoes_produtos(self):
        """Converte a tabela amigável para o JSON esperado pela automação."""
        resultado = {}
        for linha in range(self.tabela_excecoes.rowCount()):
            campo_cnpj = self.tabela_excecoes.cellWidget(linha, 0)
            item_codigos = self.tabela_excecoes.item(linha, 1)
            cnpj_digitado = campo_cnpj.text().strip() if campo_cnpj else ""
            codigos_digitados = item_codigos.text().strip() if item_codigos else ""

            # Linhas completamente vazias não alteram a lógica automática.
            if not cnpj_digitado and not codigos_digitados:
                continue
            cnpj = re.sub(r"\D", "", cnpj_digitado)
            if len(cnpj) != 14:
                QMessageBox.warning(
                    self, "CNPJ inválido",
                    f"Confira o CNPJ da linha {linha + 1}. Ele deve ter 14 números.",
                )
                return None
            partes = [p for p in re.split(r"[\s,;]+", codigos_digitados) if p]
            if not partes or any(not p.isdigit() for p in partes):
                QMessageBox.warning(
                    self, "Código de produto inválido",
                    f"Informe apenas números separados por vírgula na linha {linha + 1}.",
                )
                return None
            if cnpj in resultado:
                QMessageBox.warning(
                    self, "CNPJ repetido",
                    f"O CNPJ {cnpj} aparece mais de uma vez. Coloque todos os códigos na mesma linha.",
                )
                return None
            container = self.tabela_excecoes.cellWidget(linha, 2)
            checkbox = container.findChild(QCheckBox) if container else None
            resultado[cnpj] = {
                "ativo": checkbox.isChecked() if checkbox else True,
                "codigos_produto": sorted({int(parte) for parte in partes}),
            }
        return resultado

    def carregar_excecoes_produtos(self, dados_excecoes):
        self.tabela_excecoes.setRowCount(0)
        if not isinstance(dados_excecoes, dict):
            return
        mapa = dados_excecoes.get("excecoes_por_cnpj", dados_excecoes)
        if not isinstance(mapa, dict):
            return
        for cnpj, configuracao in mapa.items():
            if not isinstance(configuracao, dict):
                continue
            self.adicionar_linha_excecao(
                cnpj,
                configuracao.get("codigos_produto", []),
                configuracao.get("ativo", True),
            )

    def salvar_template_atual(self):
        retaguarda = self.combo_retaguarda.currentText().strip()
        if not retaguarda:
            QMessageBox.warning(self, "Aviso", "Selecione um nome válido!")
            return
        if retaguarda not in self.templates_data:
            self.templates_data[retaguarda] = {}
        
        # 1. Coleta os dados das tabelas (VIEW/TMP)
        dados_tabelas = {}
        for chave, campos in self.inputs_tributos.items():
            dados_tabelas[chave] = {
                "view_nome": campos["view_nome"].text(), "view_sql": campos["view_sql"].toPlainText(),
                "tmp_nome": campos["tmp_nome"].text(), "tmp_delete": campos["tmp_delete"].toPlainText(),
                "flag1": campos["flag1"].isChecked(), "flag2": campos["flag2"].isChecked(), "flag3": campos["flag3"].isChecked(),
                "tmp_insert": campos["tmp_insert"].toPlainText(), "tmp_values": campos["tmp_values"].toPlainText(),
                "tmp_selectwhere": campos["tmp_selectwhere"].toPlainText()
            }
        
        # 2. Coleta os dados do widget de Comparar Divergência
        dados_divergencia = self.widget_divergencia.get_data()

        # 3. Unifica o payload com as chaves 'tabelas' e 'comparar_divergencia'
        payload_unificado = {
            "tabelas": dados_tabelas,
            "comparar_divergencia": dados_divergencia,
            # Mantem a secao vazia para limpar configuracoes antigas ao salvar.
            "excecoes_produtos": {},
        }

        self.templates_data[retaguarda] = payload_unificado
            
        self.database.save_template(retaguarda, payload_unificado)
            
        self.load_templates()
        QMessageBox.information(self, "Sucesso", f"Template '{retaguarda}' salvo com sucesso!")

    def excluir_template_atual(self):
        retaguarda = self.combo_retaguarda.currentText().strip()
        if not retaguarda or retaguarda not in self.templates_data:
            return
            
        msg_box = QMessageBox(self)
        msg_box.setWindowTitle("Excluir Template")
        msg_box.setText(f"Tem certeza que deseja excluir o template '{retaguarda}'?")
        btn_sim = msg_box.addButton("Sim", QMessageBox.ButtonRole.YesRole)
        btn_nao = msg_box.addButton("Não", QMessageBox.ButtonRole.NoRole)
        msg_box.exec()

        if msg_box.clickedButton() == btn_sim:
            del self.templates_data[retaguarda]
            self.excluir_template_do_banco(retaguarda)
            self.load_templates()

    def carregar_template_na_tela(self):
        retaguarda = self.combo_retaguarda.currentText().strip()
        dados_template_completo = self.templates_data.get(retaguarda, {})

        # 1. Carrega os dados das tabelas (VIEW/TMP) a partir da chave 'tabelas'
        dados_tabelas = dados_template_completo.get("tabelas", {})
        for chave, campos in self.inputs_tributos.items():
            dados_trib = dados_tabelas.get(chave, {})

            view_nome = dados_trib.get("view_nome", "")
            campos["view_nome"].setText(view_nome)
            campos["view_label_valor"].setText(view_nome if view_nome else "...")
            
            campos["view_sql"].setPlainText(dados_trib.get("view_sql", ""))
            
            tmp_nome = dados_trib.get("tmp_nome", "")
            campos["tmp_nome"].setText(tmp_nome)
            campos["tmp_label_valor"].setText(tmp_nome if tmp_nome else "...")

            campos["tmp_delete"].setPlainText(dados_trib.get("tmp_delete", ""))
            campos["flag1"].setChecked(dados_trib.get("flag1", True))
            campos["flag2"].setChecked(dados_trib.get("flag2", False))
            campos["flag3"].setChecked(dados_trib.get("flag3", False))
            campos["tmp_insert"].setPlainText(dados_trib.get("tmp_insert", ""))
            campos["tmp_values"].setPlainText(dados_trib.get("tmp_values", ""))
            campos["tmp_selectwhere"].setPlainText(dados_trib.get("tmp_selectwhere", ""))
        
        # 2. Carrega os dados no widget a partir da chave 'comparar_divergencia'
        dados_divergencia = dados_template_completo.get("comparar_divergencia", {})
        self.widget_divergencia.set_data(dados_divergencia)

    def importar_csv(self):
        file_path, _ = QFileDialog.getOpenFileName(self, "Selecionar CSV", "", "CSV Files (*.csv)")
        if file_path:
            try:
                adicionados = 0
                with open(file_path, mode="r", encoding="utf-8") as f:
                    reader = csv.reader(f)
                    for row in reader:
                        if row:
                            cnpj = row[0].strip()
                            adicionados += self.adicionar_cnpj_na_fila(cnpj)
                self.atualizar_status_fila(adicionados)
            except Exception as e:
                QMessageBox.critical(self, "Erro", str(e))

    def colar_dados_dialogo(self):
        dialog = QDialog(self)
        dialog.setWindowTitle("Colar Lista (CNPJ)")
        dialog.resize(400, 350)
        layout = QVBoxLayout(dialog)
        txt_area = QTextEdit()
        layout.addWidget(txt_area)

        def processar_cola():
            texto = txt_area.toPlainText().strip()
            if not texto:
                dialog.close()
                return
            adicionados = 0
            for linha in texto.split("\n"):
                cnpj = linha.strip().replace("\t", ",").split(",")[0].strip()
                adicionados += self.adicionar_cnpj_na_fila(cnpj)
            self.atualizar_status_fila(adicionados)
            dialog.close()

        btn_ok = QPushButton("Carregar Fila")
        btn_ok.clicked.connect(processar_cola)
        layout.addWidget(btn_ok)
        dialog.exec()

    def aplicar_variaveis_texto(
        self, texto: str, estado: str, cnpj: str, nome_empresa: str = ""
    ) -> str:
        if not isinstance(texto, str):
            return texto
        return (
            texto.replace("{estado}", estado)
            .replace("{cnpj}", cnpj)
            .replace("{nome_empresa}", nome_empresa)
        )

    def adicionar_cnpj_na_fila(self, cnpj):
        """Inclui CNPJs sem apagar os anteriores; duplicados são ignorados."""
        cnpj = cnpj.strip()
        if not cnpj:
            return 0
        cnpj_normalizado = "".join(caractere for caractere in cnpj if caractere.isdigit())
        if any(
            "".join(caractere for caractere in cliente.get("cnpj", "") if caractere.isdigit()) == cnpj_normalizado
            for cliente in self.clientes_carregados
        ):
            return 0
        self.clientes_carregados.append({"cnpj": cnpj})
        linha = self.table_clientes.rowCount()
        self.table_clientes.insertRow(linha)
        self.table_clientes.setItem(linha, 0, QTableWidgetItem(cnpj))
        status = QTableWidgetItem("Pendente")
        status.setForeground(QBrush(QColor("#64748b")))
        self.table_clientes.setItem(linha, 1, status)
        return 1

    def atualizar_status_fila(self, adicionados=0):
        total = len(self.clientes_carregados)
        if adicionados:
            self.lbl_status_csv.setText(f"Fila: {total} CNPJs ({adicionados} adicionados agora).")
        else:
            self.lbl_status_csv.setText(f"Fila: {total} CNPJs (nenhum novo; duplicados foram ignorados).")

    def limpar_grid_clientes(self):
        if not self.clientes_carregados:
            return
        self.clientes_carregados = []
        self.table_clientes.setRowCount(0)
        self.lbl_status_csv.setText("Nenhum cliente carregado na fila.")

    def marcar_cliente_concluido(self, cnpj_concluido):
        cnpj_normalizado = "".join(caractere for caractere in cnpj_concluido if caractere.isdigit())
        for linha in range(self.table_clientes.rowCount()):
            item_cnpj = self.table_clientes.item(linha, 0)
            if not item_cnpj:
                continue
            valor_normalizado = "".join(caractere for caractere in item_cnpj.text() if caractere.isdigit())
            if valor_normalizado != cnpj_normalizado:
                continue
            for coluna in range(self.table_clientes.columnCount()):
                item = self.table_clientes.item(linha, coluna)
                if item:
                    item.setBackground(QBrush(QColor("#dcfce7")))
                    item.setForeground(QBrush(QColor("#166534")))
            self.table_clientes.item(linha, 1).setText("✓ Concluído")
            self.table_clientes.scrollToItem(item_cnpj)
            break

    def adicionar_cnpj_fila(self):
        cnpj = self.ent_cnpj_manual.text().strip()
        if not cnpj:
            QMessageBox.warning(self, "Aviso", "Digite um CNPJ para adicionar à fila.")
            return
        self.clientes_carregados.append({"cnpj": cnpj})
        r = self.table_clientes.rowCount()
        self.table_clientes.insertRow(r)
        self.table_clientes.setItem(r, 0, QTableWidgetItem(cnpj))
        self.ent_cnpj_manual.clear()
        self.lbl_status_csv.setText(f"Carregados {len(self.clientes_carregados)} CNPJs.")

    def iniciar_automacao(self):
        usuario = self.ent_user.text().strip()
        senha = self.ent_pass.text().strip()
        self.download_dialog = None
        
        if not usuario or not senha:
            QMessageBox.warning(self, "Aviso", "Preencha o usuário e a senha do Mix antes de iniciar!")
            return
            
        if not self.clientes_carregados:
            QMessageBox.warning(self, "Aviso", "Nenhum cliente carregado na fila para automação!")
            return

        retaguarda_selecionada = self.combo_template_exec.currentText().strip()
        if not retaguarda_selecionada:
            retaguarda_selecionada = self.combo_retaguarda.currentText().strip()

        if retaguarda_selecionada and retaguarda_selecionada in self.templates_data:
            dados_template = json.loads(json.dumps(self.templates_data[retaguarda_selecionada]))
        else:
            QMessageBox.warning(self, "Aviso", f"O template '{retaguarda_selecionada}' não foi encontrado ou está vazio. Verifique a aba de configurações.")
            return

        if not any(
            any(
                (value.strip() if isinstance(value, str) else bool(value))
                for value in campos.values()
            )
            for secao in dados_template.values() if isinstance(secao, dict) for campos in secao.values()
        ):
            QMessageBox.warning(self, "Aviso", f"O template '{retaguarda_selecionada}' não possui dados cadastrados!")
            return

        total_steps = max(1, len(self.clientes_carregados) * 8)
        self.progress_bar.setMaximum(total_steps)
        self.progress_bar.setValue(0)
        self.btn_executar.setEnabled(False)
        self.btn_executar.setText("⏳ Executando Automação...")
        self.log(f"🚀 Iniciando automação usando o Template: [{retaguarda_selecionada}]...")

        if self.worker and getattr(self.worker, "isRunning", lambda: False)():
            try:
                self.log("Encerrando a automacao e o navegador anteriores...")
                self.worker.requestInterruption()
                if not self.worker.wait(5_000):
                    QMessageBox.warning(
                        self,
                        "Automacao anterior em encerramento",
                        "O navegador anterior ainda esta sendo fechado. Aguarde alguns segundos e tente novamente.",
                    )
                    self.btn_executar.setEnabled(True)
                    self.btn_executar.setText("Iniciar Automacao (Login & Tabelas)")
                    return
            except Exception as erro:
                self.log(f"Falha ao encerrar a automacao anterior: {erro}")

        automation_config = {
            "user": usuario,
            "pass": senha,
            "headless": not self.chk_mostrar_navegador.isChecked(),
            "delay_multiplier": self.delay_multiplier,
        }

        self.worker = AutomacaoWorker(automation_config, self.clientes_carregados, dados_template)
        self.worker.log_signal.connect(self.log)
        self.worker.progress_signal.connect(self.atualizar_progresso)
        self.worker.cliente_concluido_signal.connect(self.marcar_cliente_concluido)
        self.worker.download_necessario_signal.connect(self.mostrar_dialogo_download)
        self.worker.download_progress_signal.connect(self.atualizar_progresso_download)
        self.worker.download_concluido_signal.connect(self.fechar_dialogo_download)
        self.worker.finished_signal.connect(self.fim_automacao)
        self.worker.finished_signal.connect(
            lambda: getattr(self, 'worker', None) and self.worker.deleteLater()
        )
        self.btn_pause.setEnabled(True)
        self.btn_resume.setEnabled(False)
        self.worker.start()

    def mostrar_dialogo_download(self):
        """Ajusta a barra de progresso principal para o modo indeterminado durante o download."""
        # O instalador nem sempre informa porcentagens quando roda sem um
        # terminal. O modo ocupado mantem a barra animada nesse caso.
        self.progress_bar.setRange(0, 0)
        self.progress_bar.setFormat("Baixando componentes do navegador (Chromium)...")

    def atualizar_progresso_download(self, percentual):
        """Atualiza a barra de progresso com a porcentagem do download."""
        self.progress_bar.setRange(0, 100)
        self.progress_bar.setValue(percentual)
        self.progress_bar.setFormat(f"Baixando Chromium do Playwright: {percentual}%")

    def fechar_dialogo_download(self):
        """Restaura a barra de progresso principal para o modo normal."""
        total_steps = max(1, len(self.clientes_carregados) * 8)
        self.progress_bar.setMaximum(total_steps)
        self.progress_bar.setValue(0)
        self.progress_bar.setFormat("Progresso: %p%")
        self.atualizar_progresso(0, max(1, len(self.clientes_carregados) * 8))

    def fim_automacao(self):
        self.log("✔️ Automação finalizada.")
        self.btn_executar.setEnabled(True)
        self.btn_executar.setText("🚀 Iniciar Automação (Login & Tabelas)")
        self.btn_pause.setEnabled(False)
        self.btn_resume.setEnabled(False)
        if self.worker and getattr(self.worker, "isRunning", lambda: False)():
            try:
                self.worker.wait(5_000)
            except Exception:
                pass
        self.worker = None

    def set_speed_mode(self, modo: str):
        if modo == "normal":
            self.delay_multiplier = 1.0
            texto = "Normal"
        elif modo == "rapida":
            self.delay_multiplier = 0.6
            texto = "Rápida"
        else:
            self.delay_multiplier = 0.3
            texto = "Ultra"
        self.lbl_speed.setText(f"Velocidade: {texto}")
        self.log(f"⏱️ Velocidade ajustada para {texto} ({self.delay_multiplier:.2f}x)")
        if self.worker and getattr(self.worker, "isRunning", lambda: False)():
            self.worker.delay_multiplier = self.delay_multiplier

    def pausar_automacao(self):
        if self.worker:
            self.worker.pause()
            self.btn_pause.setEnabled(False)
            self.btn_resume.setEnabled(True)
            self.log("⏸️ Automação pausada. Clique em continuar para retomar.")

    def continuar_automacao(self):
        if self.worker:
            self.worker.resume()
            self.btn_pause.setEnabled(True)
            self.btn_resume.setEnabled(False)
            self.log("▶️ Automação retomada.")

    def atualizar_progresso(self, atual: int, total: int):
        if total <= 0:
            self.progress_bar.setValue(0)
            return
        self.progress_bar.setMaximum(total)
        self.progress_bar.setValue(atual)
        self.log(f"📈 Progresso: {atual}/{total} passos")


def executar_app():
    """Inicia a interface e torna visiveis erros que um arquivo .pyw ocultaria."""
    app = QApplication(sys.argv)
    try:
        window = MainWindow()
        return app.exec()
    except Exception:
        detalhes = traceback.format_exc()
        try:
            (APP_DIR / "erro_inicializacao.log").write_text(detalhes, encoding="utf-8")
        except OSError:
            pass
        QMessageBox.critical(
            None,
            "Erro ao iniciar o APP MIX",
            "O aplicativo nao conseguiu iniciar.\n\n"
            f"Detalhes foram salvos em:\n{APP_DIR / 'erro_inicializacao.log'}",
        )
        return 1


if __name__ == "__main__":
    sys.exit(executar_app())
