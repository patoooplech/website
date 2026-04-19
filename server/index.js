const express = require("express");
const app = express();
const port = process.env.PORT || 3000;
const cors = require("cors");
const sql = require('mssql');
const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: { encrypt: true, trustServerCertificate: true }
};

sql.connect(config).then(() => {
  console.log('Pripojené k SQL Server databáze');
}).catch(err => {
  console.error('Chyba pripojenia:', err);
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// FAKTÚRY
// ============================================================

app.get("/faktury", async (req, res) => {
  try {
    // OPRAVA: subquery nesmie referovať viacero stlpcov z outer query naraz (MSSQL obmedzenie)
    // Riešenie: suma_bez_dph cez subquery, suma_s_dph vypočítať vo vonkajšom SELECT
    const result = await sql.query(`
      SELECT
        f.id_faktura,
        f.cislo_faktury,
        f.datum_vystavenia,
        f.datum_splatnosti,
        f.zaplatena,
        f.sadzba_dph,
        f.variabilny_symbol,
        f.vsimka,
        f.id_zakazka,
        z.cislo_zakazky,
        zak.meno AS zakaznik_meno,
        sub.suma_bez_dph,
        ROUND(sub.suma_bez_dph * (1 + f.sadzba_dph / 100.0), 2) AS suma_s_dph
      FROM firma.faktury f
      JOIN firma.zakazky z ON f.id_zakazka = z.id_zakazka
      JOIN firma.zakaznici zak ON z.id_zakaznik = zak.id_zakaznik
      CROSS APPLY (
        SELECT ISNULL(SUM(p.cena_za_ks * p.mnozstvo * (1 - COALESCE(p.zlava_percent,0)/100.0)), 0) AS suma_bez_dph
        FROM firma.polozky_zakazky p
        WHERE p.id_zakazka = f.id_zakazka
      ) sub
      ORDER BY f.datum_vystavenia DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error("Chyba pri /faktury:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/faktury/:id", async (req, res) => {
  try {
    const request = new sql.Request();
    request.input('id', sql.Int, req.params.id);
    const result = await request.query(`
      SELECT
        f.id_faktura,
        f.cislo_faktury,
        f.datum_vystavenia,
        f.datum_splatnosti,
        f.zaplatena,
        f.datum_uhrady,
        f.sadzba_dph,
        f.variabilny_symbol,
        f.vsimka,
        f.id_zakazka,
        z.cislo_zakazky,
        z.datum_zakazky,
        z.datum_dodania,
        z.poznamka AS poznamka_zakazky,
        zak.id_zakaznik,
        zak.meno AS zakaznik_meno,
        zak.ulica,
        zak.mesto,
        zak.psc,
        zak.email,
        zak.telefon,
        zak.ico,
        zak.dic,
        zak.ic_dph,
        zak.stat,
        sub.suma_bez_dph,
        ROUND(sub.suma_bez_dph * (1 + f.sadzba_dph / 100.0), 2) AS suma_s_dph
      FROM firma.faktury f
      JOIN firma.zakazky z ON f.id_zakazka = z.id_zakazka
      JOIN firma.zakaznici zak ON z.id_zakaznik = zak.id_zakaznik
      CROSS APPLY (
        SELECT ISNULL(SUM(p.cena_za_ks * p.mnozstvo * (1 - COALESCE(p.zlava_percent,0)/100.0)), 0) AS suma_bez_dph
        FROM firma.polozky_zakazky p
        WHERE p.id_zakazka = f.id_zakazka
      ) sub
      WHERE f.id_faktura = @id
    `);
    if (result.recordset.length === 0) return res.status(404).json({ error: "Faktúra nenájdená" });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/faktury/:id", async (req, res) => {
  try {
    const request = new sql.Request();
    request.input('id', sql.Int, req.params.id);
    await request.query('DELETE FROM firma.faktury WHERE id_faktura = @id');
    res.json({ message: "Faktúra vymazaná" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/faktury", async (req, res) => {
  const { cislo_faktury, id_zakazka, datum_vystavenia, datum_splatnosti, zaplatena, variabilny_symbol, vsimka, sadzba_dph } = req.body;
  try {
    const request = new sql.Request();
    request.input('cislo_faktury', sql.VarChar(20), cislo_faktury);
    request.input('id_zakazka', sql.Int, id_zakazka);
    request.input('datum_vystavenia', sql.Date, datum_vystavenia || new Date());
    request.input('datum_splatnosti', sql.Date, datum_splatnosti);
    request.input('zaplatena', sql.Bit, zaplatena || 0);
    request.input('variabilny_symbol', sql.VarChar(20), variabilny_symbol || null);
    request.input('vsimka', sql.VarChar(500), vsimka || null);
    request.input('sadzba_dph', sql.Decimal(5, 2), sadzba_dph || 20.0);
    const result = await request.query(`
      INSERT INTO firma.faktury (cislo_faktury, id_zakazka, datum_vystavenia, datum_splatnosti, zaplatena, variabilny_symbol, vsimka, sadzba_dph)
      VALUES (@cislo_faktury, @id_zakazka, @datum_vystavenia, @datum_splatnosti, @zaplatena, @variabilny_symbol, @vsimka, @sadzba_dph)
      SELECT SCOPE_IDENTITY() AS id_novej_faktury
    `);
    res.json({ message: "Faktúra pridaná", id: result.recordset[0].id_novej_faktury });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/faktury/:id/zaplatit", async (req, res) => {
  try {
    const request = new sql.Request();
    request.input('id', sql.Int, req.params.id);
    request.input('datum', sql.Date, new Date());
    await request.query(`UPDATE firma.faktury SET zaplatena = 1, datum_uhrady = @datum WHERE id_faktura = @id`);
    res.json({ message: "Faktúra označená ako zaplatená" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ZÁKAZKY
// ============================================================

app.get("/zakazky", async (req, res) => {
  try {
    const result = await sql.query(`
      SELECT
        z.id_zakazka,
        z.cislo_zakazky,
        z.datum_zakazky,
        z.datum_dodania,
        z.poznamka AS poznamka_zakazky,
        z.id_zakaznik,
        z.id_stav,
        z.id_zodpovedny,
        s.nazov_stavu,
        zak.meno AS zakaznik_meno,
        ISNULL(zam.meno + ' ' + zam.priezvisko, '') AS zodpovedny_meno,
        sub.celkova_suma,
        ISNULL((SELECT COUNT(*) FROM firma.polozky_zakazky p WHERE p.id_zakazka = z.id_zakazka), 0) AS pocet_poloziek,
        ISNULL((SELECT COUNT(*) FROM firma.faktury f WHERE f.id_zakazka = z.id_zakazka), 0) AS pocet_faktur
      FROM firma.zakazky z
      JOIN firma.zakaznici zak ON z.id_zakaznik = zak.id_zakaznik
      JOIN firma.stavy_zakazky s ON z.id_stav = s.id_stav
      LEFT JOIN firma.zamestnanci zam ON z.id_zodpovedny = zam.id_zamestnanec
      CROSS APPLY (
        SELECT ISNULL(SUM(p.cena_za_ks * p.mnozstvo * (1 - COALESCE(p.zlava_percent,0)/100.0)), 0) AS celkova_suma
        FROM firma.polozky_zakazky p
        WHERE p.id_zakazka = z.id_zakazka
      ) sub
      ORDER BY z.datum_zakazky DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error("Chyba pri /zakazky:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/zakazky/:id", async (req, res) => {
  try {
    const request = new sql.Request();
    request.input('id', sql.Int, req.params.id);
    const result = await request.query(`
      SELECT
        z.id_zakazka,
        z.cislo_zakazky,
        z.datum_zakazky,
        z.datum_dodania,
        z.poznamka AS poznamka_zakazky,
        z.id_zakaznik,
        z.id_stav,
        z.id_zodpovedny,
        s.nazov_stavu,
        zak.meno AS zakaznik_meno,
        zak.ulica,
        zak.mesto,
        zak.psc,
        zak.email,
        zak.telefon,
        zak.ico,
        zak.dic,
        zak.ic_dph,
        zak.stat,
        ISNULL(zam.meno + ' ' + zam.priezvisko, '') AS zodpovedny_meno,
        sub.celkova_suma
      FROM firma.zakazky z
      JOIN firma.zakaznici zak ON z.id_zakaznik = zak.id_zakaznik
      JOIN firma.stavy_zakazky s ON z.id_stav = s.id_stav
      LEFT JOIN firma.zamestnanci zam ON z.id_zodpovedny = zam.id_zamestnanec
      CROSS APPLY (
        SELECT ISNULL(SUM(p.cena_za_ks * p.mnozstvo * (1 - COALESCE(p.zlava_percent,0)/100.0)), 0) AS celkova_suma
        FROM firma.polozky_zakazky p
        WHERE p.id_zakazka = z.id_zakazka
      ) sub
      WHERE z.id_zakazka = @id
    `);
    if (result.recordset.length === 0) return res.status(404).json({ error: "Zákazka nenájdená" });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/zakazky/:id/polozky", async (req, res) => {
  try {
    const request = new sql.Request();
    request.input('id', sql.Int, req.params.id);
    const result = await request.query(`
      SELECT
        p.id_polozka,
        p.mnozstvo,
        p.cena_za_ks,
        p.zlava_percent,
        p.id_vyrobok,
        v.nazov AS nazov_vyrobku,
        v.popis AS popis_vyrobku,
        v.material,
        v.farba,
        t.nazov AS typ_vyrobku,
        ROUND(p.cena_za_ks * p.mnozstvo * (1 - COALESCE(p.zlava_percent,0)/100.0), 2) AS cena_celkom
      FROM firma.polozky_zakazky p
      JOIN firma.vyrobky v ON p.id_vyrobok = v.id_vyrobok
      JOIN firma.typy_vyrobkov t ON v.id_typ = t.id_typ
      WHERE p.id_zakazka = @id
      ORDER BY p.id_polozka
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/zakazky/:id/polozky", async (req, res) => {
  const { id_vyrobok, mnozstvo, cena_za_ks, zlava_percent } = req.body;
  try {
    const request = new sql.Request();
    request.input('id_zakazka', sql.Int, req.params.id);
    request.input('id_vyrobok', sql.Int, id_vyrobok);
    request.input('mnozstvo', sql.Int, mnozstvo || 1);
    request.input('cena_za_ks', sql.Decimal(10, 2), cena_za_ks);
    request.input('zlava_percent', sql.Decimal(5, 2), zlava_percent || 0);
    await request.query(`
      INSERT INTO firma.polozky_zakazky (id_zakazka, id_vyrobok, mnozstvo, cena_za_ks, zlava_percent)
      VALUES (@id_zakazka, @id_vyrobok, @mnozstvo, @cena_za_ks, @zlava_percent)
    `);
    res.json({ message: "Položka pridaná" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/zakazky/:id/historia", async (req, res) => {
  try {
    const request = new sql.Request();
    request.input('id', sql.Int, req.params.id);
    const result = await request.query(`
      SELECT
        h.id_historia,
        h.datum_zmeny,
        h.poznamka AS poznamka_historia,
        s_old.nazov_stavu AS stav_old,
        s_new.nazov_stavu AS stav_new,
        ISNULL(zam.meno + ' ' + zam.priezvisko, '') AS zamestnanec
      FROM firma.historia_zakaziek h
      LEFT JOIN firma.stavy_zakazky s_old ON h.id_stav_old = s_old.id_stav
      JOIN firma.stavy_zakazky s_new ON h.id_stav_new = s_new.id_stav
      LEFT JOIN firma.zamestnanci zam ON h.id_zamestnanec = zam.id_zamestnanec
      WHERE h.id_zakazka = @id
      ORDER BY h.datum_zmeny DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/zakazky/:id/dodacie-listy", async (req, res) => {
  try {
    const request = new sql.Request();
    request.input('id', sql.Int, req.params.id);
    const result = await request.query(`SELECT * FROM firma.dodacie_listy WHERE id_zakazka = @id ORDER BY datum_vystavenia DESC`);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/zakazky", async (req, res) => {
  const { id_zakaznik, id_zodpovedny, datum_dodania, poznamka } = req.body;
  try {
    const request = new sql.Request();
    request.input('id_zakaznik', sql.Int, id_zakaznik);
    request.input('id_zodpovedny', sql.Int, id_zodpovedny || null);
    request.input('datum_dodania', sql.Date, datum_dodania || null);
    request.input('poznamka', sql.VarChar(500), poznamka || null);
    const result = await request.query(`
      DECLARE @cislo VARCHAR(20) = 'Z' + FORMAT(GETDATE(), 'yyyy') + RIGHT('000' + CAST((SELECT ISNULL(MAX(id_zakazka),0)+1 FROM firma.zakazky) AS VARCHAR), 3)
      INSERT INTO firma.zakazky (id_zakaznik, id_zodpovedny, datum_dodania, poznamka, cislo_zakazky)
      VALUES (@id_zakaznik, @id_zodpovedny, @datum_dodania, @poznamka, @cislo)
      SELECT SCOPE_IDENTITY() AS id_novej_zakazky
    `);
    res.json({ message: "Zákazka pridaná", id: result.recordset[0].id_novej_zakazky });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/zakazky/:id", async (req, res) => {
  try {
    const req1 = new sql.Request();
    req1.input('id', sql.Int, req.params.id);
    const check = await req1.query('SELECT COUNT(*) AS cnt FROM firma.faktury WHERE id_zakazka = @id');
    if (check.recordset[0].cnt > 0) {
      return res.status(400).json({ error: "Zákazka má faktúry, nedá sa vymazať" });
    }
    const req2 = new sql.Request();
    req2.input('id', sql.Int, req.params.id);
    await req2.query('DELETE FROM firma.polozky_zakazky WHERE id_zakazka = @id');
    const req3 = new sql.Request();
    req3.input('id', sql.Int, req.params.id);
    await req3.query('DELETE FROM firma.zakazky WHERE id_zakazka = @id');
    res.json({ message: "Zákazka vymazaná" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ZÁKAZNÍCI
// ============================================================

app.get("/zakaznici", async (req, res) => {
  try {
    const result = await sql.query(`
      SELECT
        z.id_zakaznik,
        z.meno,
        z.ulica,
        z.mesto,
        z.psc,
        z.email,
        z.telefon,
        z.ico,
        z.dic,
        z.ic_dph,
        z.stat,
        z.poznamka AS poznamka_zakaznika,
        ISNULL((SELECT COUNT(*) FROM firma.zakazky zk WHERE zk.id_zakaznik = z.id_zakaznik), 0) AS pocet_zakaziek,
        ISNULL((SELECT COUNT(*) FROM firma.zakazky zk JOIN firma.faktury f ON zk.id_zakazka = f.id_zakazka WHERE zk.id_zakaznik = z.id_zakaznik), 0) AS pocet_faktur
      FROM firma.zakaznici z
      ORDER BY z.meno
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/zakaznici/:id", async (req, res) => {
  try {
    const request = new sql.Request();
    request.input('id', sql.Int, req.params.id);
    const result = await request.query(`SELECT * FROM firma.zakaznici WHERE id_zakaznik = @id`);
    if (result.recordset.length === 0) return res.status(404).json({ error: "Zákazník nenájdený" });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/zakaznici/:id/zakazky", async (req, res) => {
  try {
    const request = new sql.Request();
    request.input('id', sql.Int, req.params.id);
    const result = await request.query(`
      SELECT
        z.id_zakazka,
        z.cislo_zakazky,
        z.datum_zakazky,
        z.datum_dodania,
        s.nazov_stavu,
        sub.celkova_suma,
        ISNULL((SELECT COUNT(*) FROM firma.faktury f WHERE f.id_zakazka = z.id_zakazka), 0) AS pocet_faktur
      FROM firma.zakazky z
      JOIN firma.stavy_zakazky s ON z.id_stav = s.id_stav
      CROSS APPLY (
        SELECT ISNULL(SUM(p.cena_za_ks * p.mnozstvo * (1 - COALESCE(p.zlava_percent,0)/100.0)), 0) AS celkova_suma
        FROM firma.polozky_zakazky p WHERE p.id_zakazka = z.id_zakazka
      ) sub
      WHERE z.id_zakaznik = @id
      ORDER BY z.datum_zakazky DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/zakaznici/:id/faktury", async (req, res) => {
  try {
    const request = new sql.Request();
    request.input('id', sql.Int, req.params.id);
    const result = await request.query(`
      SELECT
        f.id_faktura,
        f.cislo_faktury,
        f.datum_vystavenia,
        f.datum_splatnosti,
        f.zaplatena,
        f.sadzba_dph,
        sub.suma_bez_dph,
        ROUND(sub.suma_bez_dph * (1 + f.sadzba_dph / 100.0), 2) AS suma_s_dph
      FROM firma.faktury f
      JOIN firma.zakazky z ON f.id_zakazka = z.id_zakazka
      CROSS APPLY (
        SELECT ISNULL(SUM(p.cena_za_ks * p.mnozstvo * (1 - COALESCE(p.zlava_percent,0)/100.0)), 0) AS suma_bez_dph
        FROM firma.polozky_zakazky p WHERE p.id_zakazka = f.id_zakazka
      ) sub
      WHERE z.id_zakaznik = @id
      ORDER BY f.datum_vystavenia DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/zakaznici", async (req, res) => {
  const { meno, priezvisko, email, telefon, ulica, mesto, psc, ico, dic, ic_dph, stat, poznamka } = req.body;
  const plneMeno = priezvisko ? `${meno} ${priezvisko}`.trim() : (meno || '').trim();
  if (!plneMeno) return res.status(400).json({ error: "Meno je povinné" });
  try {
    const request = new sql.Request();
    request.input('meno', sql.VarChar(100), plneMeno);
    request.input('ulica', sql.VarChar(100), ulica || '');
    request.input('mesto', sql.VarChar(100), mesto || '');
    request.input('psc', sql.VarChar(10), psc || '');
    request.input('email', sql.VarChar(100), email || null);
    request.input('telefon', sql.VarChar(20), telefon || null);
    request.input('ico', sql.VarChar(20), ico || null);
    request.input('dic', sql.VarChar(20), dic || null);
    request.input('ic_dph', sql.VarChar(20), ic_dph || null);
    request.input('stat', sql.VarChar(50), stat || 'Slovensko');
    request.input('poznamka', sql.VarChar(200), poznamka || null);
    await request.query(`
      INSERT INTO firma.zakaznici (meno, ulica, mesto, psc, email, telefon, ico, dic, ic_dph, stat, poznamka)
      VALUES (@meno, @ulica, @mesto, @psc, @email, @telefon, @ico, @dic, @ic_dph, @stat, @poznamka)
    `);
    res.json({ message: "Zákazník pridaný" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/zakaznici/:id", async (req, res) => {
  try {
    const req1 = new sql.Request();
    req1.input('id', sql.Int, req.params.id);
    const check = await req1.query('SELECT COUNT(*) AS cnt FROM firma.zakazky WHERE id_zakaznik = @id');
    if (check.recordset[0].cnt > 0) return res.status(400).json({ error: "Zákazník má zákazky, nedá sa vymazať" });
    const req2 = new sql.Request();
    req2.input('id', sql.Int, req.params.id);
    await req2.query('DELETE FROM firma.zakaznici WHERE id_zakaznik = @id');
    res.json({ message: "Zákazník vymazaný" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



app.get("/vyrobky", async (req, res) => {
  try {
    const result = await sql.query(`
      SELECT
        vs.id_vyrobok,
        vs.nazov,
        vs.cena,
        vs.popis,
        vs.material,
        vs.farba,
        vs.sklad_mnozstvo AS sklad,
        t.nazov AS typ_vyrobku,
        t.id_typ
      FROM firma.vyrobky_sklad vs
      JOIN firma.typy_vyrobkov t ON vs.id_typ = t.id_typ
      ORDER BY t.nazov, vs.nazov
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/typy-vyrobkov", async (req, res) => {
  try {
    const result = await sql.query(`
      SELECT t.id_typ, t.nazov,
        COUNT(v.id_vyrobok) AS pocet_vyrobkov,
        ISNULL(SUM(vs.sklad_mnozstvo), 0) AS celkove_mnozstvo
      FROM firma.typy_vyrobkov t
      LEFT JOIN firma.vyrobky v ON t.id_typ = v.id_typ
      LEFT JOIN firma.vyrobky_sklad vs ON v.id_vyrobok = vs.id_vyrobok
      GROUP BY t.id_typ, t.nazov
      ORDER BY t.nazov
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/vyrobky/:id/pohyby", async (req, res) => {
  try {
    const request = new sql.Request();
    request.input('id', sql.Int, req.params.id);
    const result = await request.query(`
      SELECT sp.id_pohyb, sp.typ_pohybu, sp.mnozstvo, sp.datum_pohybu, sp.poznamka, z.cislo_zakazky
      FROM firma.skladove_pohyby sp
      LEFT JOIN firma.zakazky z ON sp.id_zakazka = z.id_zakazka
      WHERE sp.id_vyrobok = @id
      ORDER BY sp.datum_pohybu DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// REKLAMÁCIE
// ============================================================

app.get("/reklamacie", async (req, res) => {
  try {
    const result = await sql.query(`
      SELECT
        r.id_reklamacia,
        r.datum_reklamacie AS datum,
        r.dovod AS popis,
        r.stav_reklamacie AS stav,
        r.vybavene_dna,
        r.poznamka AS poznamka_reklamacie,
        z.cislo_zakazky,
        zak.meno AS zakaznik_meno,
        v.nazov AS nazov_vyrobku
      FROM firma.reklamacie r
      JOIN firma.zakazky z ON r.id_zakazka = z.id_zakazka
      JOIN firma.zakaznici zak ON z.id_zakaznik = zak.id_zakaznik
      JOIN firma.vyrobky v ON r.id_vyrobok = v.id_vyrobok
      ORDER BY r.datum_reklamacie DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PLATBY
// ============================================================

app.get("/platby", async (req, res) => {
  try {
    const result = await sql.query(`
      SELECT p.id_platba, p.suma, p.datum_platby, p.sposob_platby, f.cislo_faktury, zak.meno AS zakaznik_meno
      FROM firma.platby p
      JOIN firma.faktury f ON p.id_faktura = f.id_faktura
      JOIN firma.zakazky z ON f.id_zakazka = z.id_zakazka
      JOIN firma.zakaznici zak ON z.id_zakaznik = zak.id_zakaznik
      ORDER BY p.datum_platby DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/platby", async (req, res) => {
  const { id_faktura, suma, sposob_platby } = req.body;
  try {
    const request = new sql.Request();
    request.input('id_faktura', sql.Int, id_faktura);
    request.input('suma', sql.Money, suma);
    request.input('sposob_platby', sql.VarChar(30), sposob_platby || 'Prevodom');
    request.input('datum', sql.Date, new Date());
    await request.query(`INSERT INTO firma.platby (id_faktura, suma, datum_platby, sposob_platby) VALUES (@id_faktura, @suma, @datum, @sposob_platby)`);
    const req2 = new sql.Request();
    req2.input('id_faktura', sql.Int, id_faktura);
    req2.input('datum', sql.Date, new Date());
    await req2.query(`UPDATE firma.faktury SET zaplatena = 1, datum_uhrady = @datum WHERE id_faktura = @id_faktura`);
    res.json({ message: "Platba zaznamenaná" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ZAMESTNANCI
// ============================================================

app.get("/zamestnanci", async (req, res) => {
  try {
    const result = await sql.query(`
      SELECT id_zamestnanec, meno, priezvisko, pracovna_pozicia, email
      FROM firma.zamestnanci WHERE aktivny = 1
      ORDER BY priezvisko
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ŠTATISTIKY
// ============================================================

app.get("/statistiky", async (req, res) => {
  try {
    const result = await sql.query(`
      SELECT
        (SELECT COUNT(*) FROM firma.faktury) AS celkom_faktur,
        (SELECT COUNT(*) FROM firma.faktury WHERE zaplatena = 1) AS zaplatene_faktury,
        (SELECT COUNT(*) FROM firma.faktury WHERE zaplatena = 0) AS nezaplatene_faktury,
        (SELECT COUNT(*) FROM firma.zakazky) AS celkom_zakaziek,
        (SELECT COUNT(*) FROM firma.zakaznici) AS celkom_zakaznikov,
        (SELECT COUNT(*) FROM firma.reklamacie WHERE stav_reklamacie != 'vybavená') AS otvorene_reklamacie,
        (SELECT ISNULL(SUM(suma), 0) FROM firma.platby) AS celkove_prijmy,
        (SELECT ISNULL(SUM(p.cena_za_ks * p.mnozstvo * (1 - COALESCE(p.zlava_percent,0)/100.0)), 0)
         FROM firma.polozky_zakazky p
         JOIN firma.faktury f ON f.id_zakazka = p.id_zakazka
         WHERE f.zaplatena = 0) AS pohladavky
    `);
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// DEBUG
// ============================================================

app.get("/debug", async (req, res) => {
  const results = {};
  const queries = {
    faktury: `SELECT TOP 1 f.id_faktura, f.cislo_faktury, zak.meno AS zakaznik_meno FROM firma.faktury f JOIN firma.zakazky z ON f.id_zakazka = z.id_zakazka JOIN firma.zakaznici zak ON z.id_zakaznik = zak.id_zakaznik`,
    zakazky: `SELECT TOP 1 z.id_zakazka, z.cislo_zakazky, zak.meno AS zakaznik_meno FROM firma.zakazky z JOIN firma.zakaznici zak ON z.id_zakaznik = zak.id_zakaznik`,
    zakaznici: `SELECT TOP 1 id_zakaznik, meno FROM firma.zakaznici`,
    vyrobky: `SELECT TOP 1 vs.id_vyrobok, vs.nazov, t.nazov AS typ FROM firma.vyrobky_sklad vs JOIN firma.typy_vyrobkov t ON vs.id_typ = t.id_typ`,
    reklamacie: `SELECT TOP 1 r.id_reklamacia, zak.meno AS zakaznik_meno FROM firma.reklamacie r JOIN firma.zakazky z ON r.id_zakazka = z.id_zakazka JOIN firma.zakaznici zak ON z.id_zakaznik = zak.id_zakaznik JOIN firma.vyrobky v ON r.id_vyrobok = v.id_vyrobok`,
    statistiky: `SELECT COUNT(*) AS cnt FROM firma.faktury`,
    cross_apply_test: `SELECT TOP 1 f.id_faktura, sub.suma_bez_dph, ROUND(sub.suma_bez_dph * (1 + f.sadzba_dph/100.0),2) AS suma_s_dph FROM firma.faktury f CROSS APPLY (SELECT ISNULL(SUM(p.cena_za_ks * p.mnozstvo * (1 - COALESCE(p.zlava_percent,0)/100.0)),0) AS suma_bez_dph FROM firma.polozky_zakazky p WHERE p.id_zakazka = f.id_zakazka) sub`,
  };
  for (const [key, q] of Object.entries(queries)) {
    try {
      const r = await sql.query(q);
      results[key] = { ok: true, sample: r.recordset[0] };
    } catch (err) {
      results[key] = { ok: false, error: err.message };
    }
  }
  res.json(results);
});

app.listen(port, () => {
  console.log(`Server beží na porte ${port}`);
});
