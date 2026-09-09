"""Interface do instalador automatizado do Mix Fiscal Integrador."""

from __future__ import annotations

import sys

from PyQt6.QtCore import QRectF, Qt, QThread, pyqtSignal
from PyQt6.QtGui import QColor, QIcon, QPainter, QPen, QPixmap
from PyQt6.QtWidgets import (
    QApplication, QFrame, QHBoxLayout, QLabel, QLineEdit, QMessageBox,
    QProgressBar, QPushButton, QScrollArea, QSizePolicy, QToolButton, QVBoxLayout, QWidget,
)

from automacao_primeiro_acesso import install
from instalador_core import InstallError


APP_STYLE = """
QWidget#root {
    background: #f3f6f4;
    color: #12211d;
    font-family: "Segoe UI";
    font-size: 14px;
}
QFrame#brand {
    background: #123c30;
    border-radius: 20px;
}
QLabel#brandMark {
    color: #123c30;
    background: #d9efb0;
    border-radius: 18px;
    font-size: 17px;
    font-weight: 800;
}
QLabel#brandName { color: #ffffff; font-size: 20px; font-weight: 700; }
QLabel#brandTag { color: #bdd1c9; font-size: 12px; }
QLabel#eyebrow { color: #1f6b52; font-size: 11px; font-weight: 800; }
QLabel#title { color: #12211d; font-size: 25px; font-weight: 700; }
QLabel#subtitle { color: #65736e; font-size: 13px; }
QFrame#card {
    background: #ffffff;
    border: 1px solid #dfe7e2;
    border-radius: 18px;
}
QScrollArea { background: transparent; border: 0; }
QScrollArea > QWidget > QWidget { background: transparent; }
QLabel.fieldLabel { color: #33443e; font-size: 12px; font-weight: 700; }
QLineEdit {
    min-height: 44px;
    padding: 0 13px;
    color: #12211d;
    background: #ffffff;
    border: 1px solid #d5dfda;
    border-radius: 10px;
    selection-background-color: #1f6b52;
}
QLineEdit:focus { border: 2px solid #4e8c75; padding: 0 12px; }
QLineEdit:disabled { color: #7d8a85; background: #eef2f0; }
QToolButton#eyeButton {
    min-width: 42px;
    min-height: 42px;
    background: #f6f9f7;
    border: 1px solid #d5dfda;
    border-radius: 10px;
}
QToolButton#eyeButton:hover { background: #eaf4ef; border-color: #8db9a6; }
QLabel#privacy { color: #74827d; font-size: 11px; }
QLabel#status {
    padding: 11px 13px;
    color: #315e4e;
    background: #f0f7f3;
    border: 1px solid #d3e6dc;
    border-radius: 10px;
}
QProgressBar {
    min-height: 7px;
    max-height: 7px;
    border: 0;
    border-radius: 3px;
    background: #e4ebe7;
}
QProgressBar::chunk { border-radius: 3px; background: #1f6b52; }
QPushButton#installButton {
    min-height: 46px;
    padding: 0 24px;
    color: #ffffff;
    background: #1f6b52;
    border: 0;
    border-radius: 11px;
    font-size: 14px;
    font-weight: 700;
}
QPushButton#installButton:hover { background: #185741; }
QPushButton#installButton:pressed { background: #124536; }
QPushButton#installButton:disabled { color: #dbe6e1; background: #78978b; }
QLabel#footer { color: #89958f; font-size: 11px; }
"""


def eye_icon(hidden: bool) -> QIcon:
    pixmap = QPixmap(26, 22)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    painter.setPen(QPen(QColor("#53635d"), 1.8))
    painter.drawEllipse(QRectF(3.0, 5.5, 20.0, 11.0))
    painter.drawEllipse(QRectF(10.0, 8.5, 6.0, 6.0))
    if hidden:
        painter.setPen(QPen(QColor("#53635d"), 2.1))
        painter.drawLine(4, 3, 22, 19)
    painter.end()
    return QIcon(pixmap)


class InstallWorker(QThread):
    progress = pyqtSignal(str)
    succeeded = pyqtSignal(dict)
    failed = pyqtSignal(str)

    def __init__(self, cnpj: str, username: str, password: str):
        super().__init__()
        self.values = cnpj, username, password

    def run(self):
        cnpj, username, password = self.values
        try:
            result = install(cnpj, username, password, progress=self.progress.emit)
            self.succeeded.emit(result)
        except Exception as exc:
            message = str(exc) if isinstance(exc, InstallError) else f"Falha inesperada: {exc}"
            self.failed.emit(message)


class InstallerWindow(QWidget):
    def __init__(self):
        super().__init__()
        self.worker = None
        self.password_visible = False
        self.setObjectName("root")
        self.setWindowTitle("Mix Fiscal | Instalador do Integrador")
        self.setStyleSheet(APP_STYLE)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        content = QWidget()
        content.setObjectName("root")
        scroll.setWidget(content)
        outer.addWidget(scroll)

        root = QVBoxLayout(content)
        root.setContentsMargins(30, 26, 30, 22)
        root.setSpacing(18)
        root.addWidget(self._brand())

        eyebrow = QLabel("CONFIGURAÇÃO ASSISTIDA")
        eyebrow.setObjectName("eyebrow")
        title = QLabel("Instalar Integrador")
        title.setObjectName("title")
        subtitle = QLabel(
            "Configure esta máquina, ative o monitoramento e confirme a conexão com o App Mix."
        )
        subtitle.setObjectName("subtitle")
        subtitle.setWordWrap(True)
        root.addWidget(eyebrow)
        root.addWidget(title)
        root.addWidget(subtitle)
        root.addWidget(self._form_card())

        footer = QLabel("MIX FISCAL  •  INSTALAÇÃO SEGURA DO INTEGRADOR")
        footer.setObjectName("footer")
        footer.setAlignment(Qt.AlignmentFlag.AlignCenter)
        root.addWidget(footer)

        screen = QApplication.primaryScreen()
        available = screen.availableGeometry() if screen else None
        width = min(720, max(500, (available.width() - 32) if available else 720))
        height = min(700, max(500, (available.height() - 32) if available else 700))
        self.resize(width, height)
        self.setMinimumSize(480, 480)
        if available:
            self.move(
                available.x() + (available.width() - width) // 2,
                available.y() + (available.height() - height) // 2,
            )

    def _brand(self) -> QFrame:
        frame = QFrame()
        frame.setObjectName("brand")
        frame.setFixedHeight(82)
        layout = QHBoxLayout(frame)
        layout.setContentsMargins(20, 14, 20, 14)
        layout.setSpacing(13)
        mark = QLabel("MF")
        mark.setObjectName("brandMark")
        mark.setFixedSize(48, 48)
        mark.setAlignment(Qt.AlignmentFlag.AlignCenter)
        copy = QVBoxLayout()
        copy.setSpacing(1)
        name = QLabel("Mix Fiscal")
        name.setObjectName("brandName")
        tag = QLabel("Tecnologia para uma operação fiscal conectada")
        tag.setObjectName("brandTag")
        tag.setWordWrap(True)
        tag.setMinimumWidth(0)
        copy.addWidget(name)
        copy.addWidget(tag)
        layout.addWidget(mark)
        layout.addLayout(copy)
        layout.addStretch()
        return frame

    def _field(self, label: str, editor: QWidget) -> QVBoxLayout:
        layout = QVBoxLayout()
        layout.setSpacing(6)
        caption = QLabel(label)
        caption.setProperty("class", "fieldLabel")
        layout.addWidget(caption)
        layout.addWidget(editor)
        return layout

    def _form_card(self) -> QFrame:
        card = QFrame()
        card.setObjectName("card")
        card.setMinimumHeight(410)
        layout = QVBoxLayout(card)
        layout.setContentsMargins(24, 22, 24, 22)
        layout.setSpacing(15)

        self.cnpj = QLineEdit()
        self.cnpj.setInputMask("00.000.000/0000-00;_")
        self.cnpj.setAccessibleName("CNPJ")
        self.username = QLineEdit()
        self.username.setPlaceholderText("Digite seu usuário")
        self.username.setPlaceholderText("Usuário do Integrador")
        self.username.setClearButtonEnabled(True)
        self.password = QLineEdit()
        self.password.setPlaceholderText("Digite sua senha")
        self.password.setEchoMode(QLineEdit.EchoMode.Password)
        self.password.returnPressed.connect(self.start)

        password_row = QWidget()
        password_layout = QHBoxLayout(password_row)
        password_layout.setContentsMargins(0, 0, 0, 0)
        password_layout.setSpacing(8)
        password_layout.addWidget(self.password, 1)
        self.eye = QToolButton()
        self.eye.setObjectName("eyeButton")
        self.eye.setIcon(eye_icon(True))
        self.eye.setIconSize(self.eye.sizeHint())
        self.eye.setToolTip("Mostrar senha")
        self.eye.setAccessibleName("Mostrar ou ocultar senha")
        self.eye.clicked.connect(self.toggle_password)
        password_layout.addWidget(self.eye)

        layout.addLayout(self._field("CNPJ", self.cnpj))
        layout.addLayout(self._field("Login", self.username))
        layout.addLayout(self._field("Senha", password_row))

        privacy = QLabel("● A senha é usada somente durante a instalação e não fica salva.")
        privacy.setObjectName("privacy")
        privacy.setWordWrap(True)
        privacy.setMinimumWidth(0)
        layout.addWidget(privacy)

        self.status = QLabel("Pronto para instalar e ativar o monitor.")
        self.status.setObjectName("status")
        self.status.setWordWrap(True)
        layout.addWidget(self.status)

        self.bar = QProgressBar()
        self.bar.setTextVisible(False)
        self.bar.setRange(0, 1)
        self.bar.setValue(0)
        layout.addWidget(self.bar)
        layout.addStretch()

        self.button = QPushButton("Instalar Integrador e Monitor")
        self.button.setObjectName("installButton")
        self.button.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Fixed)
        self.button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.button.clicked.connect(self.start)
        layout.addWidget(self.button)
        return card

    def toggle_password(self):
        self.password_visible = not self.password_visible
        self.password.setEchoMode(
            QLineEdit.EchoMode.Normal if self.password_visible else QLineEdit.EchoMode.Password
        )
        self.eye.setIcon(eye_icon(not self.password_visible))
        self.eye.setToolTip("Ocultar senha" if self.password_visible else "Mostrar senha")

    def set_form_enabled(self, enabled: bool):
        self.cnpj.setEnabled(enabled)
        self.username.setEnabled(enabled)
        self.password.setEnabled(enabled)
        self.eye.setEnabled(enabled)
        self.button.setEnabled(enabled)

    def start(self):
        if self.worker and self.worker.isRunning():
            return
        self.set_form_enabled(False)
        self.bar.setRange(0, 0)
        self.status.setStyleSheet("")
        self.status.setText("Iniciando instalação segura...")
        self.worker = InstallWorker(self.cnpj.text(), self.username.text(), self.password.text())
        self.worker.progress.connect(self.status.setText)
        self.worker.succeeded.connect(self.done)
        self.worker.failed.connect(self.failed)
        self.worker.start()

    def finish_ui(self):
        self.bar.setRange(0, 1)
        self.bar.setValue(1)
        self.set_form_enabled(True)

    def done(self, result: dict):
        self.finish_ui()
        self.password.clear()
        self.status.setStyleSheet("color:#17653f;background:#effbf5;border-color:#86deb2;")
        self.status.setText("Instalação concluída e monitoramento ativo.")
        QMessageBox.information(
            self, "Instalação concluída",
            f"CNPJ {result['cnpj']} configurado com Mix Fiscal.\n\n"
            f"Machine ID: {result['machine_id']}\n\n"
            "O ID está online no App Mix, o Integrador foi aberto e o monitor foi instalado.",
        )

    def failed(self, message: str):
        self.finish_ui()
        self.password.clear()
        self.status.setStyleSheet("color:#962f2b;background:#fff2f1;border-color:#f1c7c4;")
        self.status.setText("A instalação não foi concluída. Revise a mensagem exibida.")
        QMessageBox.critical(self, "Erro na instalação", message)


if __name__ == "__main__":
    app = QApplication(sys.argv)
    app.setApplicationName("Instalador Mix Fiscal")
    window = InstallerWindow()
    window.show()
    raise SystemExit(app.exec())
