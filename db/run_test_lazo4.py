"""Corre db/test_lazo4_rpc.sql contra la base REAL en UNA transacción que SIEMPRE se revierte.

Uso:
  python db/run_test_lazo4.py [--lazo1 RUTA/2026-10-14_lazo_tramo1.sql]

  YUNQUE_DB_URL se lee del entorno o del .env de 05YUNQUE (hermano de este repo).
  --lazo1: si LAZO-1 aún no está aplicada en vivo, se aplica DENTRO de la misma
  transacción (y se revierte con todo lo demás). Si ya está aplicada, omitir.

Salida: EXIT 0 solo si el test terminó en 'LAZO4_TEST_OK'. Nada se commitea nunca.
"""
import argparse
import os
import pathlib
import sys

import psycopg2

AQUI = pathlib.Path(__file__).resolve().parent


def db_url():
    if os.environ.get("YUNQUE_DB_URL"):
        return os.environ["YUNQUE_DB_URL"]
    env = AQUI.parent.parent / "05YUNQUE" / ".env"
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith("YUNQUE_DB_URL="):
            return line.split("=", 1)[1].strip().strip('"')
    sys.exit("Falta YUNQUE_DB_URL")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lazo1", help="migración LAZO-1 a aplicar dentro de la transacción")
    a = ap.parse_args()

    partes = []
    if a.lazo1:
        partes.append(pathlib.Path(a.lazo1).read_text(encoding="utf-8"))
    partes.append((AQUI / "2026-10-14_lazo4_rpc.sql").read_text(encoding="utf-8"))
    partes.append((AQUI / "test_lazo4_rpc.sql").read_text(encoding="utf-8"))

    conn = psycopg2.connect(db_url())
    conn.autocommit = False
    try:
        try:
            with conn.cursor() as cur:
                cur.execute("set local lock_timeout = '3s'")
                for sql in partes:
                    cur.execute(sql)
            print("ERROR: el test no terminó en LAZO4_TEST_OK (¿se saltó el bloque final?)")
            code = 1
        except psycopg2.Error as e:
            msg = e.diag.message_primary or str(e)
            print(msg)
            code = 0 if msg.startswith("LAZO4_TEST_OK") else 1
        finally:
            conn.rollback()
    finally:
        conn.close()
    sys.exit(code)


if __name__ == "__main__":
    main()
