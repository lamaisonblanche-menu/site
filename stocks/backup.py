#!/usr/bin/env python3
"""Sauvegarde cohérente de la base de stocks SQLite.
Usage: MB_STOCKS_DB=... python stocks/backup.py /chemin/sauvegardes
Ne remplace pas une sauvegarde externe hors SRV MB.
"""
import argparse, os, sqlite3, sys
from datetime import datetime
from pathlib import Path
def main():
    p=argparse.ArgumentParser();p.add_argument("destination");args=p.parse_args()
    source=Path(os.environ.get("MB_STOCKS_DB",str(Path(__file__).resolve().parent/"data"/"stocks.sqlite3")))
    if not source.is_file():raise SystemExit("Base source introuvable")
    target_dir=Path(args.destination).resolve();target_dir.mkdir(parents=True,exist_ok=True)
    if source.resolve().parent==target_dir:raise SystemExit("Sauvegarde sur un autre emplacement obligatoire")
    dest=target_dir/("stocks-"+datetime.now().strftime("%Y%m%d-%H%M%S-%f")+".sqlite3")
    with sqlite3.connect(source) as src,sqlite3.connect(dest) as dst:
        src.backup(dst)
        check=dst.execute("PRAGMA integrity_check").fetchone()[0]
        if check!="ok":
            dest.unlink(missing_ok=True)
            raise SystemExit("Échec vérification sauvegarde : "+str(check))
    print("Sauvegarde vérifiée :",dest)
if __name__=="__main__":main()
