#!/usr/bin/env python3
"""Crée l'autorité de certification privée de La Maison Blanche et le certificat HTTPS du serveur des stocks.

  py creer_certificats.py --data C:\\MBStocks\\data --nom SRV-MB --ip 192.168.1.10

Produit dans data/tls/ :
  autorite-mb.crt   à installer sur le PC magasinier (« Autorités de certification racines de confiance »)
  autorite-mb.key   clé de l'autorité : reste sur SRV MB (sert à renouveler le certificat)
  serveur.crt / serveur.key   utilisés par le serveur
Nécessite le module « cryptography » (py -m pip install cryptography).
"""
import argparse, datetime, ipaddress
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID


def save_key(k, p):
    p.write_bytes(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))


def main():
    a = argparse.ArgumentParser(); a.add_argument("--data", required=True); a.add_argument("--nom", action="append", default=[]); a.add_argument("--ip", action="append", default=[])
    a.add_argument("--renouveler", action="store_true", help="refaire le certificat serveur avec l'autorité existante")
    args = a.parse_args()
    d = Path(args.data) / "tls"; d.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_crt, ca_key = d / "autorite-mb.crt", d / "autorite-mb.key"
    if ca_crt.exists() and ca_key.exists():
        ca = x509.load_pem_x509_certificate(ca_crt.read_bytes()); ck = serialization.load_pem_private_key(ca_key.read_bytes(), None)
    else:
        ck = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Autorité La Maison Blanche (stocks)"), x509.NameAttribute(NameOID.ORGANIZATION_NAME, "La Maison Blanche")])
        ca = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(ck.public_key()).serial_number(x509.random_serial_number())
              .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=3650))
              .add_extension(x509.BasicConstraints(ca=True, path_length=0), True)
              .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), True)
              .add_extension(x509.SubjectKeyIdentifier.from_public_key(ck.public_key()), False)
              .sign(ck, hashes.SHA256()))
        save_key(ck, ca_key); ca_crt.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    names = args.nom or ["localhost"]
    ips = args.ip + ["127.0.0.1"]
    san = [x509.DNSName(n) for n in dict.fromkeys(names + ["localhost"])] + [x509.IPAddress(ipaddress.ip_address(i)) for i in dict.fromkeys(ips)]
    sk = ec.generate_private_key(ec.SECP256R1())
    crt = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, names[0])])).issuer_name(ca.subject)
           .public_key(sk.public_key()).serial_number(x509.random_serial_number())
           .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=1825))
           .add_extension(x509.SubjectAlternativeName(san), False)
           .add_extension(x509.BasicConstraints(ca=False, path_length=None), True)
           .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), False)
           .add_extension(x509.KeyUsage(True, False, True, False, False, False, False, False, False), True)
           .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ck.public_key()), False)
           .sign(ck, hashes.SHA256()))
    save_key(sk, d / "serveur.key"); (d / "serveur.crt").write_bytes(crt.public_bytes(serialization.Encoding.PEM))
    print("Certificats créés dans", d, "— noms :", ", ".join(names), "— IP :", ", ".join(ips))


if __name__ == "__main__":
    main()
