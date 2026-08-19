import re
from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QApplication,
    QCheckBox,
    QFrame,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)
from PyQt6.QtGui import QResizeEvent

UI_NAMES = {
    "pis_cofins": "PIS/COFINS:",
    "ncm": "NCM",
    "ncmex": "NCMEX",
    "cod_natureza_receita": "Cód. Natureza Receita",
    "credito_presumido": "Crédito Presumido",
    "pis_cst_e": "PIS CST E",
    "pis_cst_s": "PIS CST S",
    "pis_alq_e": "PIS ALQ E",
    "pis_alq_s": "PIS ALQ S",
    "cofins_cst_e": "COFINS CST E",
    "cofins_cst_s": "COFINS CST S",
    "cofins_alq_e": "COFINS ALQ E",
    "cofins_alq_s": "COFINS ALQ S",
    "icms_entrada": "ICMS de Entrada:",
    "ei": "EI",
    "ed": "ED",
    "es": "ES",
    "nf": "NF",
    "outros_icms": "",
    "cst": "CST",
    "alq": "ALQ",
    "alqst": "ALQST",
    "rbc": "RBC",
    "rbcst": "RBCST",
    "nfi_cst": "NFI_CST",
    "nfd_cst": "NFD_CST",
    "nfs_csosn": "NFS_CSOSN",
    "mva": "MVA",
    "tipo_mva": "Tipo MVA",
    "mva_data_ini": "MVA Data Ini",
    "mva_data_fim": "MVA Data Fim",
    "cred_outorgado": "Cred. Outorgado",
    "gera_debito": "Gera Débito",
    "sub_rbc_alq": "sub_rbc_alq",
    "icms_saida": "ICMS de Saída:",
    "sac": "SAC",
    "sas": "SAS",
    "svc": "SVC",
    "snc": "SNC",
    "simples_nacional": "Simples Nacional:",
    "cbenef_alq": "CBENEF_ALQ",
    "cest": "CEST",
    "re29560": "RE29560",
    "fecp": "FECP",
    "fecp_st": "FECP_ST",
    "sss_csosn": "SSS_CSOSN",
    "svc_csosn": "SVC_CSOSN",
    "snc_csosn": "SNC_CSOSN",
    "ibs_cbs": "IBS/CBS:",
    "ibs_cbs_rural": "IBS/CBS(RURAL):",
    "ibs_cbs_gov": "IBS/CBS(GOV):",
    "classe_tributaria": "Classe Tributária",
    "ibs_cbs_cst": "IBS/CBS CST",
    "cbs_alq": "CBS ALQ",
    "cbs_alq_rbc": "CBS ALQ RBC",
    "ibs_uf_alq": "IBS UF ALQ",
    "ibs_uf_alq_rbc": "IBS UF ALQ RBC",
    "ibs_mun_alq": "IBS MUN ALQ",
    "ibs_mun_alq_rbc": "IBS MUN ALQ RBC",
    "is_classe_tributaria": "IS Classe Tributária",
    "is_alq": "IS ALQ",
    "is_alq_especifica": "IS ALQ Específica",
    "outros": "Outros",
    "fundamento_legal": "Fundamento Legal",
}


class CompararDivergenciaWidget(QWidget):

    def __init__(self, parent=None):
        super().__init__(parent)
        self.checkboxes = {}


        # CSS com fonte maior (12px para CheckBox e 13px para Títulos)
        self.setStyleSheet("""
            QGroupBox {
                font-weight: normal;
                font-size: 13px;
                border: 1px solid #b0b0b0;
                border-radius: 4px;
                margin-top: 6px;
                background-color: #ffffff;
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                subcontrol-position: top left;
                padding: 0 4px;
                background-color: #ffffff;
                color: #262626;
            }
            QCheckBox {
                font-size: 12px;
                color: #222222;
                spacing: 6px;
            }
            QLabel {
                font-size: 12px;
                font-weight: bold;
                color: #444444;
            }
        """)

        self.main_layout = QVBoxLayout(self)
        self.main_layout.setContentsMargins(2, 2, 2, 2)
        self.scroll_area = QScrollArea()
        self._setup_ui()

    def _get_ui_name(self, key: str) -> str:
        return UI_NAMES.get(key, key)

    def _setup_ui(self):
        scroll = self.scroll_area
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)

        scroll_content = QWidget()
        content_layout = QVBoxLayout(scroll_content)
        content_layout.setSpacing(8)
        content_layout.setContentsMargins(4, 4, 4, 4)

        # ----------------------------------------------------------------------
        # 1. PIS / COFINS (Grid 4 colunas)
        # ----------------------------------------------------------------------
        group_pc = QGroupBox("PIS/COFINS:")
        grid_pc = QGridLayout(group_pc)
        grid_pc.setContentsMargins(12, 10, 12, 8)
        grid_pc.setHorizontalSpacing(30)
        grid_pc.setVerticalSpacing(4)

        pc_structure = [
            ("ncm", "ncmex", "cod_natureza_receita", "credito_presumido"),
            ("pis_cst_e", "pis_cst_s", "pis_alq_e", "pis_alq_s"),
            ("cofins_cst_e", "cofins_cst_s", "cofins_alq_e", "cofins_alq_s"),
        ]

        for row_idx, row_keys in enumerate(pc_structure):
            for col_idx, key in enumerate(row_keys):
                chk = QCheckBox(self._get_ui_name(key))
                self.checkboxes[f"pis_cofins.{key}"] = chk
                grid_pc.addWidget(chk, row_idx, col_idx)

        content_layout.addWidget(group_pc)

        # ----------------------------------------------------------------------
        # 2. IBS / CBS (3 blocos lado a lado)
        # ----------------------------------------------------------------------
        group_ibs_container = QWidget()
        lay_ibs_main = QHBoxLayout(group_ibs_container)
        lay_ibs_main.setContentsMargins(0, 0, 0, 0)
        lay_ibs_main.setSpacing(6)

        ibs_items = [
            "classe_tributaria",
            "cbs_alq",
            "ibs_uf_alq",
            "ibs_mun_alq",
            "is_classe_tributaria",
            "is_alq_especifica",
            "ibs_cbs_cst",
            "cbs_alq_rbc",
            "ibs_uf_alq_rbc",
            "ibs_mun_alq_rbc",
            "is_alq",
        ]

        for ibs_group_key in ["ibs_cbs", "ibs_cbs_rural", "ibs_cbs_gov"]:
            box = QGroupBox(self._get_ui_name(ibs_group_key))
            grid = QGridLayout(box)
            grid.setContentsMargins(8, 8, 8, 6)
            grid.setHorizontalSpacing(12)
            grid.setVerticalSpacing(2)

            for idx, key in enumerate(ibs_items):
                chk = QCheckBox(self._get_ui_name(key))
                self.checkboxes[f"{ibs_group_key}.{key}"] = chk
                grid.addWidget(chk, idx % 6, 0 if idx < 6 else 1)

            lay_ibs_main.addWidget(box)

        content_layout.addWidget(group_ibs_container)

        # ----------------------------------------------------------------------
        # 3. ICMS DE ENTRADA
        # ----------------------------------------------------------------------
        group_icms_e = QGroupBox("ICMS de Entrada:")
        lay_icms_e = QHBoxLayout(group_icms_e)
        lay_icms_e.setContentsMargins(12, 10, 12, 8)
        lay_icms_e.setSpacing(35)

        entrada_columns = {
            "ei": ["cst", "alq", "alqst", "rbc", "rbcst"],
            "ed": ["cst", "alq", "alqst", "rbc", "rbcst"],
            "es": ["cst", "alq", "alqst", "rbc", "rbcst"],
            "nf": ["nfi_cst", "nfd_cst", "nfs_csosn", "alq"],
            "outros_icms": [
                "mva",
                "tipo_mva",
                "mva_data_ini",
                "mva_data_fim",
                "cred_outorgado",
                "gera_debito",
                "sub_rbc_alq",
            ],
        }

        for sub_key, items in entrada_columns.items():
            col_widget = QWidget()
            v_layout = QVBoxLayout(col_widget)
            v_layout.setContentsMargins(0, 0, 0, 0)
            v_layout.setSpacing(3)

            lbl_txt = self._get_ui_name(sub_key)
            if lbl_txt:
                v_layout.addWidget(QLabel(lbl_txt))

            for item_key in items:
                chk = QCheckBox(self._get_ui_name(item_key))
                self.checkboxes[f"icms_entrada.{sub_key}.{item_key}"] = chk
                v_layout.addWidget(chk)

            v_layout.addStretch()
            lay_icms_e.addWidget(col_widget)

        content_layout.addWidget(group_icms_e)

        # ----------------------------------------------------------------------
        # 4. ICMS DE SAÍDA
        # ----------------------------------------------------------------------
        group_icms_s = QGroupBox("ICMS de Saída:")
        lay_icms_s = QVBoxLayout(group_icms_s)
        lay_icms_s.setContentsMargins(12, 10, 12, 8)
        lay_icms_s.setSpacing(4)

        top_saida_container = QWidget()
        h_saida = QHBoxLayout(top_saida_container)
        h_saida.setContentsMargins(0, 0, 0, 0)
        h_saida.setSpacing(35)

        saida_columns = {
            "sac": [
                "cst",
                "alq",
                "alqst",
                "rbc",
                "rbcst",
                "cbenef_alq",
                "cest",
            ],
            "sas": [
                "cst",
                "alq",
                "alqst",
                "rbc",
                "rbcst",
                "cbenef_alq",
                "re29560",
            ],
            "svc": ["cst", "alq", "alqst", "rbc", "rbcst", "cbenef_alq", "fecp"],
            "snc": [
                "cst",
                "alq",
                "alqst",
                "rbc",
                "rbcst",
                "cbenef_alq",
                "fecp_st",
            ],
        }

        for sub_key, items in saida_columns.items():
            col_widget = QWidget()
            v_layout = QVBoxLayout(col_widget)
            v_layout.setContentsMargins(0, 0, 0, 0)
            v_layout.setSpacing(3)

            v_layout.addWidget(QLabel(self._get_ui_name(sub_key)))
            for item_key in items:
                chk = QCheckBox(self._get_ui_name(item_key))
                self.checkboxes[f"icms_saida.{sub_key}.{item_key}"] = chk
                v_layout.addWidget(chk)

            v_layout.addStretch()
            h_saida.addWidget(col_widget)

        lay_icms_s.addWidget(top_saida_container)

        bot_sn_container = QWidget()
        h_sn = QHBoxLayout(bot_sn_container)
        h_sn.setContentsMargins(0, 4, 0, 0)
        h_sn.setSpacing(35)

        lbl_sn = QLabel("Simples Nacional:")
        lbl_sn.setFixedWidth(120)
        h_sn.addWidget(lbl_sn)

        sn_items = [
            ("sss_csosn", "SSS_CSOSN"),
            ("svc_csosn", "SVC_CSOSN"),
            ("snc_csosn", "SNC_CSOSN"),
        ]
        for key_sn, label_sn in sn_items:
            chk = QCheckBox(label_sn)
            self.checkboxes[f"icms_saida.simples_nacional.{key_sn}"] = chk
            h_sn.addWidget(chk)

        h_sn.addStretch()
        lay_icms_s.addWidget(bot_sn_container)

        content_layout.addWidget(group_icms_s)

        scroll.setWidget(scroll_content)
        self.main_layout.addWidget(self.scroll_area)

    def get_data(self) -> dict:
        data = {}
        for key_path, checkbox in self.checkboxes.items():
            keys = key_path.split(".")
            current_level = data
            for i, key in enumerate(keys):
                if i == len(keys) - 1:
                    current_level[key] = checkbox.isChecked()
                else:
                    current_level = current_level.setdefault(key, {})
        return data

    def set_data(self, data: dict):
        if not isinstance(data, dict):
            return
        flat_data = self._flatten_dict(data)
        for key_path, checkbox in self.checkboxes.items():
            estado = flat_data.get(key_path, False)
            checkbox.setChecked(estado)

    def _flatten_dict(
        self, d: dict, parent_key: str = "", sep: str = "."
    ) -> dict:
        items = []
        for k, v in d.items():
            new_key = parent_key + sep + k if parent_key else k
            if isinstance(v, dict):
                items.extend(self._flatten_dict(v, new_key, sep=sep).items())
            else:
                items.append((new_key, v))
        return dict(items)

    def showEvent(self, event):
        """Ajusta a altura ao ser exibido."""
        super().showEvent(event)
        self.adjust_height()

    def resizeEvent(self, event: QResizeEvent):
        """Ajusta a altura quando o próprio widget é redimensionado."""
        super().resizeEvent(event)
        self.adjust_height()

    def adjust_height(self):
        """Ajusta a altura do widget para tentar mostrar todo o conteúdo."""
        if not self.isVisible():
            return

        content = self.scroll_area.widget()
        if content:
            ideal_height = content.sizeHint().height() + 10  # Adiciona uma pequena margem
            self.setFixedHeight(ideal_height)