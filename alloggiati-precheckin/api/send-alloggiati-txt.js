// Vercel Serverless Function: Send Alloggiati TXT via Resend
// Path: /api/send-alloggiati-txt.js

import fs from 'fs';
import path from 'path';

/**********************************************
 * RATE LIMITING - In-memory store
 **********************************************/
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 ora in ms
const RATE_LIMIT_MAX = 10; // max 10 invii per IP per ora

function getRateLimitKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress || 'unknown';
  return ip;
}

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  
  if (!record) {
    rateLimitMap.set(ip, { count: 1, firstRequest: now });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  
  if (now - record.firstRequest > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { count: 1, firstRequest: now });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  
  record.count++;
  if (record.count > RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 };
  }
  return { allowed: true, remaining: RATE_LIMIT_MAX - record.count };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // RATE LIMITING CHECK
    const clientIP = getRateLimitKey(req);
    const rateCheck = checkRateLimit(clientIP);
    res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, rateCheck.remaining));
    
    if (!rateCheck.allowed) {
      return res.status(429).json({ 
        error: "Too many requests",
        message: "Troppe richieste. Riprova più tardi."
      });
    }

    // HONEYPOT CHECK
    const { honeypot } = req.body;
    if (honeypot) {
      console.log(`[SECURITY] Honeypot triggered by IP: ${clientIP}`);
      return res.status(200).json({ status: "ok" });
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing RESEND_API_KEY" });
    }

    const {
      appartamento,
      dataArrivo,
      dataPartenza,
      numeroNotti,
      guests
    } = req.body;

    // Validazione input robusta
    if (!appartamento || typeof appartamento !== 'string' || appartamento.trim().length === 0) {
      return res.status(400).json({ error: "Invalid apartment" });
    }

    if (!dataArrivo || !/^\d{4}-\d{2}-\d{2}$/.test(dataArrivo)) {
      return res.status(400).json({ error: "Invalid arrival date format" });
    }

    if (!dataPartenza || !/^\d{4}-\d{2}-\d{2}$/.test(dataPartenza)) {
      return res.status(400).json({ error: "Invalid departure date format" });
    }

    if (!guests || !Array.isArray(guests) || guests.length === 0) {
      return res.status(400).json({ error: "Missing required fields: guests" });
    }

    if (guests.length > 5) {
      return res.status(400).json({ error: "Maximum 5 guests allowed" });
    }

    /**********************************************
     * HELPER FUNCTIONS
     **********************************************/
    
    // Determina tipo alloggiato (evita duplicazione codice)
    const determineTipoAlloggiato = (guest, index, totalGuests) => {
      const clean = (val) => (val === undefined || val === null || val === "undefined") ? "" : String(val);
      let tipo = clean(guest.tipoAlloggiato);
      
      if (!tipo) {
        tipo = (index === 0 && totalGuests > 1) ? "17" : (index === 0 ? "16" : "19");
      } else if (index === 0 && totalGuests > 1 && tipo === "16") {
        tipo = "17";
      }
      
      return tipo;
    };

    /**********************************************
     * GENERAZIONE TXT SECONDO IL FORMATO ALLOGGIATI WEB
     * Formato ufficiale Polizia di Stato
     **********************************************/
    const pad = (val, len) => String(val || "").substring(0, len).padEnd(len, " ");
    const padNum = (val, len) => String(val || "0").padStart(len, "0").substring(0, len);

    // Formato data: gg/mm/aaaa (10 caratteri)
    const formatDate = (d) => {
      if (!d) return "          "; // 10 spazi
      const parts = d.split("-");
      if (parts.length !== 3) return "          ";
      const [year, month, day] = parts;
      return `${day}/${month}/${year}`; // gg/mm/aaaa
    };

    let lines = [];

    for (let i = 0; i < guests.length; i++) {
      const g = guests[i];
      
      // Helper per pulire undefined/null
      const clean = (val) => (val === undefined || val === null || val === "undefined") ? "" : String(val);
      
      // Determina tipo alloggiato usando funzione helper
      const tipoAlloggiato = determineTipoAlloggiato(g, i, guests.length);

      // Sesso: deve essere 1 (maschio) o 2 (femmina) - NON convertire in M/F
      let sesso = clean(g.sesso);
      if (!sesso) sesso = " "; // fallback: spazio se vuoto
      
      // Mappatura tipo documento al formato Alloggiati Web
      const mapTipoDoc = (tipo) => {
        const mapping = {
          "PASS": "PASAP",  // Passaporto
          "ID": "IDENT",    // Carta d'identità
          "DL": "PATEN"     // Patente
        };
        return mapping[tipo?.toUpperCase()] || tipo || "";
      };
      
      // Solo il primo ospite (capofamiglia/capogruppo) ha i dati documento
      // Per familiari e membri gruppo (i > 0), i campi documento sono vuoti
      const isFirstGuest = (i === 0);
      const tipoDoc = isFirstGuest ? mapTipoDoc(clean(g.tipoDocumento)) : "";
      const numDoc = isFirstGuest ? clean(g.numeroDocumento).toUpperCase() : "";
      const luogoRil = isFirstGuest ? clean(g.luogoRilascio) : "";
      
      // Costruisce la riga secondo formato Alloggiati Web (168 caratteri totali)
      // Tipo(2) + DataArrivo(10) + Permanenza(2) + Cognome(50) + Nome(30) + Sesso(1) + DataNascita(10) + ComuneNascita(9) + ProvinciaNascita(2) + StatoNascita(9) + Cittadinanza(9) + TipoDoc(5) + NumeroDoc(20) + LuogoRilascio(9) = 168 caratteri
      
      // Per clienti stranieri: comune e provincia nascita vuoti, stato nascita = cittadinanza, luogo rilascio = cittadinanza
      const ITALY_CODE = "100000100";
      const cittadinanzaCode = clean(g.cittadinanza) || "";
      const isItalian = cittadinanzaCode === ITALY_CODE;
      
      // Comune nascita: solo per italiani, altrimenti vuoto
      const comuneNascitaTxt = isItalian ? pad(clean(g.comuneNascita), 9) : pad("", 9);
      
      // Provincia nascita: solo per italiani, altrimenti vuoto
      const provinciaNascitaTxt = isItalian ? pad(clean(g.provinciaNascita).toUpperCase(), 2) : pad("", 2);
      
      // Stato nascita: per stranieri = cittadinanza, per italiani = dal form
      const statoNascitaTxt = isItalian 
        ? pad(clean(g.statoNascita) || "", 9)
        : pad(cittadinanzaCode, 9);
      
      // Luogo rilascio: per stranieri = cittadinanza se vuoto, altrimenti dal form
      let luogoRilTxt = luogoRil;
      if (!isItalian && !luogoRilTxt && cittadinanzaCode) {
        luogoRilTxt = cittadinanzaCode;
      }
      
      // Costruisce la riga esatta secondo formato Alloggiati Web (168 caratteri totali)
      const line = 
        pad(tipoAlloggiato, 2) +                                              // Tipo Alloggiato (2)
        formatDate(dataArrivo) +                                              // Data Arrivo gg/mm/aaaa (10)
        padNum(clean(g.giorni) || numeroNotti || 1, 2) +                      // Permanenza giorni (2)
        pad(clean(g.cognome).toUpperCase(), 50) +                             // Cognome (50)
        pad(clean(g.nome).toUpperCase(), 30) +                                // Nome (30)
        pad(sesso, 1) +                                                       // Sesso 1/2 (1)
        formatDate(clean(g.dataNascita)) +                                    // Data Nascita gg/mm/aaaa (10)
        comuneNascitaTxt +                                                     // Comune Nascita cod. ISTAT (9) - vuoto per stranieri
        provinciaNascitaTxt +                                                  // Provincia Nascita (2) - vuoto per stranieri
        statoNascitaTxt +                                                      // Stato Nascita cod. (9) - = cittadinanza per stranieri
        pad(cittadinanzaCode, 9) +                                            // Cittadinanza cod. (9)
        pad(tipoDoc, 5) +                                                     // Tipo Documento (5)
        pad(numDoc, 20) +                                                     // Numero Documento (20)
        pad(luogoRilTxt, 9);                                                  // Luogo Rilascio cod. (9) - = cittadinanza per stranieri se vuoto

      lines.push(line);
    }

    const finalTxt = lines.join("\r\n");

    const encodedTxt = Buffer.from(finalTxt, "utf8").toString("base64");

    /**********************************************
     * GENERAZIONE FILE GIES PER ROSS1000
     * Formato pipe-delimited compatibile con gestionale Ross1000
     * 
     * Campi obbligatori (da screenshot Ross1000):
     * - Tipo alloggiato
     * - Camere occupate (default 1)
     * - Data arrivo / Data partenza
     * - Sesso, Cognome, Nome, Data nascita
     * - Cittadinanza, Stato nascita, Comune nascita
     * - Stato residenza, Comune residenza
     * - Tipo documento, Numero documento
     * - Stato rilascio, Comune rilascio
     * 
     * Struttura GIES:
     * HDR|CODICE_STRUTTURA|PRODOTTO
     * MOV|DATA|APERTURA|CAMERE_OCC|CAMERE_DISP|LETTI_DISP
     * ARR|IDSWH|TIPO|IDCAPO|SESSO|CITT|STATO_RES|COMUNE_RES|DATA_NASC|STATO_NASC|COMUNE_NASC|TIPO_TUR|MEZZO|CANALE|TITOLO|PROF|ESEN
     * PAR|IDSWH|TIPO|DATA_ARRIVO
     * PRE|IDSWH|ARRIVO|PARTENZA|OSPITI|CAMERE|PREZZO|CANALE|STATO_PROV|COMUNE_PROV
     * END
     **********************************************/
    
    // Formato data GIES: AAAAMMGG
    const formatDateGIES = (d) => {
      if (!d) return "";
      const parts = d.split("-");
      if (parts.length !== 3) return d.replace(/-/g, "");
      const [year, month, day] = parts;
      return `${year}${month}${day}`;
    };

    // Codice struttura Ross1000 per appartamento
    const getCodiceStrutturaRoss = (apt) => {
      const codes = {
        "Station Apartment": "Z07886",
        "Skyline Apartment": "Z07887",
        "Dream Studio": "M0270425422",
        "Sweet Dream Apartment": "Z04263"
      };
      return codes[apt] || "Z07886";
    };

    // Mappatura tipo alloggiato GIES
    // 16 = Capo Famiglia, 17 = Capo Gruppo, 18 = Ospite Singolo, 19 = Familiare, 20 = Membro Gruppo
    const mapTipoGIES = (tipo) => {
      const mapping = {
        "16": "18",  // Ospite singolo nel form -> 18 in GIES
        "17": "16",  // Capofamiglia nel form -> 16 in GIES
        "18": "17",  // Capogruppo nel form -> 17 in GIES
        "19": "19",  // Familiare
        "20": "20"   // Membro gruppo
      };
      return mapping[tipo] || "18";
    };

    // Sesso: M = Maschio, F = Femmina (formato XML Ross1000)
    const mapSessoGIES = (s) => {
      if (s === "1" || s === 1) return "M";
      if (s === "2" || s === 2) return "F";
      return "";
    };

    const codiceStruttura = getCodiceStrutturaRoss(appartamento);
    const dataArrivoGIES = formatDateGIES(dataArrivo);
    const dataPartenzaGIES = formatDateGIES(dataPartenza);
    
    // Genera ID ospiti univoci (basati su timestamp)
    const baseId = Date.now().toString().slice(-7);
    
    // Determina il tipo del primo ospite
    const firstGuestType = guests[0]?.tipoAlloggiato || "16";
    const tipoGIESFirst = mapTipoGIES(firstGuestType);

    let giesLines = [];
    
    // HDR - Header
    giesLines.push(`HDR|${codiceStruttura}|GIES`);
    
    // MOV - Movimento giornaliero
    // MOV|DATA|APERTURA|CAMERE_OCCUPATE|CAMERE_DISPONIBILI|LETTI_DISPONIBILI
    const camereOccupate = 1; // Modifica qui se vuoi rendere dinamico in futuro
    giesLines.push(`MOV|${dataArrivoGIES}|SI|${camereOccupate}|1|${guests.length}`);
    
    // ARR - Arrivi (uno per ogni ospite)
    let firstGuestId = null;
    for (let i = 0; i < guests.length; i++) {
      const g = guests[i];
      const clean = (val) => (val === undefined || val === null || val === "undefined") ? "" : String(val);
      
      const guestId = parseInt(baseId) + i;
      if (i === 0) firstGuestId = guestId;
      
      const isFirstGuest = (i === 0);
      let tipoAlloggiato = clean(g.tipoAlloggiato);
      if (!tipoAlloggiato) {
        // Se ci sono più ospiti, il primo è automaticamente capofamiglia
        tipoAlloggiato = (i === 0 && guests.length > 1) ? "17" : (i === 0 ? "16" : "19");
      } else if (i === 0 && guests.length > 1 && tipoAlloggiato === "16") {
        // Se il primo ospite è marcato come "Ospite Singolo" ma ci sono altri ospiti, cambialo in Capofamiglia
        tipoAlloggiato = "17";
      }
      const tipoGIES = mapTipoGIES(tipoAlloggiato);
      
      // ID Capogruppo: vuoto per primo ospite, ID del primo per gli altri
      const idCapo = isFirstGuest ? "" : firstGuestId;
      
      const sesso = mapSessoGIES(clean(g.sesso));
      // Usa il codice fornito dal form, se presente; altrimenti prova a mappare dal nome
      const cittadinanza = clean(g.cittadinanza) || "";

      // Stato di nascita: nel XML deve essere uguale alla cittadinanza
      let statoNascita = cittadinanza || "";
      // Se non c'è cittadinanza, prova a usare il valore dal form come fallback
      if (!statoNascita) {
        statoNascita = clean(g.statoNascita) || "";
        if (!statoNascita) {
          try {
            const statiPath = path.join(process.cwd(), 'data', 'stati_istat.json');
            const statiIstat = JSON.parse(fs.readFileSync(statiPath, 'utf8'));
            const statoInput = (clean(g.statoNascitaNome || g.statoNascita || "") || "").toLowerCase().trim();
            if (statoInput) {
              const statoObj = statiIstat.find(s => s.nome.toLowerCase().includes(statoInput));
              statoNascita = statoObj ? statoObj.codice : "";
            }
          } catch (e) {
            statoNascita = "";
          }
        }
      }
      const comuneNascita = clean(g.comuneNascita) || "";
      const dataNascita = formatDateGIES(clean(g.dataNascita));
      
      // Residenza: per cittadini stranieri, se comuneResidenza è vuoto, usa il codice della cittadinanza
      const statoResidenza = cittadinanza;
      let comuneResidenza = clean(g.comuneResidenza) || "";
      // Se comuneResidenza è vuoto e non è italiano, usa il codice della cittadinanza come luogo di residenza
      const ITALY_CODE = "100000100";
      if (!comuneResidenza && cittadinanza && cittadinanza !== ITALY_CODE) {
        comuneResidenza = cittadinanza;
      }
      
      // ARR|IDSWH|TIPO|IDCAPO|SESSO|CITT|STATO_RES|COMUNE_RES|DATA_NASC|STATO_NASC|COMUNE_NASC|TIPO_TUR|MEZZO|CANALE|TITOLO|PROF|ESEN
      giesLines.push(`ARR|${guestId}|${tipoGIES}|${idCapo}|${sesso}|${cittadinanza}|${statoResidenza}|${comuneResidenza}|${dataNascita}|${statoNascita}|${comuneNascita}|Non specificato|Non specificato|Non specificato|||`);
    }
    
    // PAR - Partenze (uno per ogni ospite)
    for (let i = 0; i < guests.length; i++) {
      const g = guests[i];
      const clean = (val) => (val === undefined || val === null || val === "undefined") ? "" : String(val);
      
      const guestId = parseInt(baseId) + i;
      const tipoAlloggiato = determineTipoAlloggiato(g, i, guests.length);
      const tipoGIES = mapTipoGIES(tipoAlloggiato);
      
      // PAR|IDSWH|TIPO|DATA_ARRIVO
      giesLines.push(`PAR|${guestId}|${tipoGIES}|${dataArrivoGIES}`);
    }
    
    // PRE - Prenotazione
    // PRE|IDSWH|ARRIVO|PARTENZA|OSPITI|CAMERE|PREZZO|CANALE|STATO_PROV|COMUNE_PROV
    const prenotazioneId = `P${baseId}`;
    const statoProvFirst = guests[0]?.cittadinanza || "100000100";
    const comuneProvFirst = guests[0]?.comuneResidenza || "";
    giesLines.push(`PRE|${prenotazioneId}|${dataArrivoGIES}|${dataPartenzaGIES}|${guests.length}|1|0.00|Non specificato|${statoProvFirst}|${comuneProvFirst}`);
    
    // END
    giesLines.push(`END`);
    
    const finalGIES = giesLines.join("\r\n");

    /**********************************************
     * CONVERSIONE GIES TXT -> XML
     **********************************************/
    const escapeXml = (str) => {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
    };

    let xmlArrivi = "";
    let xmlPartenze = "";
    
    for (let i = 0; i < guests.length; i++) {
      const g = guests[i];
      const clean = (val) => (val === undefined || val === null || val === "undefined") ? "" : String(val);
      
      const guestId = parseInt(baseId) + i;
      const isFirstGuest = (i === 0);
      const tipoAlloggiato = determineTipoAlloggiato(g, i, guests.length);
      const tipoGIES = mapTipoGIES(tipoAlloggiato);
      const idCapo = isFirstGuest ? "" : firstGuestId;
      
      const sesso = mapSessoGIES(clean(g.sesso));
      const cittadinanza = clean(g.cittadinanza) || "";
      // Stato di nascita: nel XML deve essere uguale alla cittadinanza
      let statoNascita = cittadinanza || "";
      // Se non c'è cittadinanza, prova a usare il valore dal form come fallback
      if (!statoNascita) {
        statoNascita = clean(g.statoNascita) || "";
        if (!statoNascita) {
          try {
            const statiPath = path.join(process.cwd(), 'data', 'stati_istat.json');
            const statiIstat = JSON.parse(fs.readFileSync(statiPath, 'utf8'));
            const statoInput = clean(g.statoNascitaNome || g.statoNascita || "").toLowerCase().trim();
            const statoObj = statiIstat.find(s => s.nome.toLowerCase().includes(statoInput));
            statoNascita = statoObj ? statoObj.codice : "";
          } catch (e) {
            statoNascita = "";
          }
        }
      }
      const comuneNascita = clean(g.comuneNascita) || "";
      const dataNascita = formatDateGIES(clean(g.dataNascita));
      // Residenza: per cittadini stranieri, se comuneResidenza è vuoto, usa il codice della cittadinanza
      const statoResidenza = cittadinanza;
      let comuneResidenza = clean(g.comuneResidenza) || "";
      // Se comuneResidenza è vuoto e non è italiano, usa il codice della cittadinanza come luogo di residenza
      const ITALY_CODE = "100000100";
      if (!comuneResidenza && cittadinanza && cittadinanza !== ITALY_CODE) {
        comuneResidenza = cittadinanza;
      }

      xmlArrivi += `
      <arrivo>
        <idswh>${guestId}</idswh>
        <tipoalloggiato>${tipoGIES}</tipoalloggiato>
        <idcapo>${idCapo}</idcapo>
        <cognome>${escapeXml(clean(g.cognome))}</cognome>
        <nome>${escapeXml(clean(g.nome))}</nome>
        <sesso>${sesso}</sesso>
        <cittadinanza>${cittadinanza}</cittadinanza>
        <statoresidenza>${statoResidenza}</statoresidenza>
        <luogoresidenza>${comuneResidenza}</luogoresidenza>
        <datanascita>${dataNascita}</datanascita>
        <statonascita>${statoNascita}</statonascita>
        <comunenascita>${comuneNascita}</comunenascita>
        <tipoturismo>Non specificato</tipoturismo>
        <mezzotrasporto>Non specificato</mezzotrasporto>
        <canaleprenotazione>Non specificato</canaleprenotazione>
        <titolostudio>Non specificato</titolostudio>
        <professione>Non specificato</professione>
        <esenzioneimposta></esenzioneimposta>
      </arrivo>`;

      xmlPartenze += `
      <partenza>
        <idswh>${guestId}</idswh>
        <tipoalloggiato>${tipoGIES}</tipoalloggiato>
        <arrivo>${dataArrivoGIES}</arrivo>
      </partenza>`;
    }

    const xmlRoss = `<?xml version="1.0" encoding="UTF-8"?>
<movimenti>
  <codice>${escapeXml(codiceStruttura)}</codice>
  <prodotto>LovelyVeniceApartments PreCheckin</prodotto>
  <movimento>
    <data>${dataArrivoGIES}</data>
    <struttura>
      <apertura>SI</apertura>
      <camereoccupate>${camereOccupate}</camereoccupate>
      <cameredisponibili>1</cameredisponibili>
      <lettidisponibili>${guests.length}</lettidisponibili>
    </struttura>
    <arrivi>${xmlArrivi}
    </arrivi>
    <partenze>${xmlPartenze}
    </partenze>
    <prenotazioni>
      <prenotazione>
        <idswh>P${baseId}</idswh>
        <arrivo>${dataArrivoGIES}</arrivo>
        <partenza>${dataPartenzaGIES}</partenza>
        <ospiti>${guests.length}</ospiti>
        <camere>1</camere>
        <prezzo>0.00</prezzo>
        <canaleprenotazione>Non specificato</canaleprenotazione>
        <statoprovenienza>${statoProvFirst}</statoprovenienza>
        <comuneprovenienza>${comuneProvFirst}</comuneprovenienza>
      </prenotazione>
    </prenotazioni>
  </movimento>
</movimenti>`;

    const encodedRoss = Buffer.from(xmlRoss, "utf8").toString("base64");

    /**********************************************
     * GENERA RIEPILOGO LEGGIBILE PER EMAIL
     **********************************************/
    const formatDateReadable = (d) => {
      if (!d) return "-";
      const parts = d.split("-");
      if (parts.length !== 3) return d;
      const [year, month, day] = parts;
      return `${day}/${month}/${year}`;
    };

    const tipoAlloggiatoLabel = (t) => {
      const labels = {
        "16": "Ospite singolo",
        "17": "Capofamiglia",
        "18": "Capogruppo",
        "19": "Familiare",
        "20": "Membro gruppo"
      };
      return labels[t] || t;
    };

    const sessoLabel = (s) => {
      if (s === "1" || s === "M") return "Maschio";
      if (s === "2" || s === "F") return "Femmina";
      return s || "-";
    };

    const tipoDocLabel = (t) => {
      const labels = {
        "IDENT": "Carta d'identità",
        "PATEN": "Patente",
        "PASSP": "Passaporto",
        "PASOR": "Passaporto ordinario",
        "PASDI": "Passaporto diplomatico",
        "PASSE": "Passaporto servizio",
        "ID": "Carta d'identità",
        "PASS": "Passaporto",
        "DL": "Patente"
      };
      return labels[t?.toUpperCase()] || t || "-";
    };

    // Costruisci riepilogo testuale
    let summary = `
════════════════════════════════════════════════════════════════
                    PRE CHECK-IN ALLOGGIATI WEB
════════════════════════════════════════════════════════════════

APPARTAMENTO:     ${appartamento || "-"}
DATA ARRIVO:      ${formatDateReadable(dataArrivo)}
DATA PARTENZA:    ${formatDateReadable(dataPartenza)}
NUMERO NOTTI:     ${numeroNotti || "-"}

────────────────────────────────────────────────────────────────
                         ELENCO OSPITI
────────────────────────────────────────────────────────────────
`;

    for (let i = 0; i < guests.length; i++) {
      const g = guests[i];
      const clean = (val) => (val === undefined || val === null || val === "undefined") ? "" : String(val);
      
      // Determina se è italiano
      const ITALY_CODE = "100000100";
      const isItalian = (clean(g.cittadinanza) || "") === ITALY_CODE;
      
      // Campi documento solo per il primo ospite
      const documentSection = i === 0 ? `│
│  Documento:         ${tipoDocLabel(clean(g.tipoDocumento))}
│  Numero:            ${clean(g.numeroDocumento).toUpperCase() || "-"}
│  Luogo rilascio:    ${clean(g.luogoRilascioNome) || "-"}
│` : '│';

      // Sezione aggiuntiva per italiani: comune nascita, comune residenza
      const italianFieldsSection = isItalian ? `│
│  Comune di nascita: ${clean(g.comuneNascitaNome) || "-"}
│  Provincia nascita: ${clean(g.provinciaNascita) || "-"}
│  Comune residenza: ${clean(g.comuneResidenzaNome) || "-"}
│` : '│';

      // Determina tipo per il riepilogo: se ci sono più ospiti, il primo è capofamiglia
      let tipoForSummary = clean(g.tipoAlloggiato);
      if (!tipoForSummary) {
        tipoForSummary = (i === 0 && guests.length > 1) ? "17" : (i === 0 ? "16" : "19");
      } else if (i === 0 && guests.length > 1 && tipoForSummary === "16") {
        tipoForSummary = "17";
      }
      
      summary += `
┌─ OSPITE ${i + 1} ─────────────────────────────────────────────
│
│  Tipo:              ${tipoAlloggiatoLabel(tipoForSummary)}
│  Cognome:           ${clean(g.cognome).toUpperCase() || "-"}
│  Nome:              ${clean(g.nome).toUpperCase() || "-"}
│  Sesso:             ${sessoLabel(clean(g.sesso))}
│  Data di nascita:   ${formatDateReadable(clean(g.dataNascita))}
│  Luogo di nascita:  ${isItalian ? (clean(g.comuneNascitaNome) || "-") : (clean(g.comuneNascitaNome) || clean(g.statoNascitaNome) || "-")}
│  Cittadinanza:      ${clean(g.cittadinanzaNome) || "-"}
${italianFieldsSection}${documentSection}
└──────────────────────────────────────────────────────────────
`;
    }

    summary += `
════════════════════════════════════════════════════════════════
ALLEGATI:
• alloggiati.txt  → File per Alloggiati Web (Polizia di Stato)
• ross1000.xml    → File XML per gestionale Ross1000
════════════════════════════════════════════════════════════════
`;

    /**********************************************
     * INVIO EMAIL CON RESEND
     **********************************************/
    const RESEND_URL = "https://api.resend.com/emails";
    // prepara nome file XML: prima parola del nome appartamento + data arrivo (AAAAMMGG)
    const sanitizeFilename = (s) => String(s || "").trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9-_]/g, '') || 'apartment';
    const aptFirst = sanitizeFilename(appartamento);
    const rossFilename = `${aptFirst}_${dataArrivoGIES}.xml`;

    const emailPayload = {
      from: "Pre Check-in <checkin@lovely-venice.it>",
      to: "appturistici.mestre@gmail.com",
      subject: `Alloggiati Web – ${appartamento} – Arrivo ${formatDateReadable(dataArrivo)}`,
      text: summary,
      attachments: [
        {
          filename: "alloggiati.txt",
          content: encodedTxt
        },
        {
          filename: rossFilename,
          content: encodedRoss
        }
      ]
    };

    const resendRes = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(emailPayload)
    });

    const resendJson = await resendRes.json();

    if (!resendRes.ok) {
      console.error('[RESEND ERROR]', {
        status: resendRes.status,
        response: resendJson,
        timestamp: new Date().toISOString()
      });
      
      // Messaggio user-friendly basato sul tipo di errore
      let userMessage = "Errore nell'invio dell'email. Riprova più tardi.";
      if (resendRes.status === 429) {
        userMessage = "Troppe richieste. Riprova tra qualche minuto.";
      } else if (resendRes.status === 401 || resendRes.status === 403) {
        userMessage = "Errore di configurazione. Contatta l'amministratore.";
      }
      
      return res.status(500).json({
        error: "Email sending failed",
        message: userMessage
      });
    }

    return res.status(200).json({
      status: "ok",
      message: "Email sent successfully",
      resend: resendJson
    });

  } catch (err) {
    // Log errore completo lato server (non esporre al client)
    console.error('[ERROR]', {
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
      timestamp: new Date().toISOString()
    });
    
    return res.status(500).json({
      error: "Server error",
      message: "Si è verificato un errore. Riprova più tardi."
    });
  }
}
