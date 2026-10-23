// What HARU can show per country: interests, the assets behind them, and where each price comes from.
// Pure data; safe on client and server.

export type CountryCode = "IN" | "CA" | "WORLD";
export type AssetKind = "stock" | "etf" | "index" | "metal" | "fx" | "crypto" | "rate" | "fund";

/** How to ask each provider for this asset. `derived` assets are computed from others. */
export interface ProviderSymbols {
  td?: string; // Twelve Data, e.g. "AAPL", "XAU/USD", "RY" (with tdExchange)
  tdExchange?: string; // e.g. "TSX", "NSE"
  av?: string; // Alpha Vantage, e.g. "RELIANCE.BSE", "SHOP.TRT"
  eod?: string; // EODHD, e.g. "RELIANCE.NSE", "RY.TO", "NSEI.INDX"
  boc?: string; // Bank of Canada Valet series, e.g. "V39079"
  mf?: string; // mfapi.in scheme code (India mutual funds)
  /** Official cross rate from two Bank of Canada series: value = first ÷ second (e.g. USD/INR = USDCAD ÷ INRCAD). */
  bocRatio?: [string, string];
}

export interface Derived {
  /** price = product of the parts' prices × factor (e.g. gold in INR per 10 g) */
  parts: { key: string; invert?: boolean }[];
  factor?: number;
}

export interface Asset {
  key: string;
  name: string;
  short: string;
  country: CountryCode;
  kind: AssetKind;
  currency: string;
  unit?: string; // "per 10 g", "per oz", "%"
  symbols: ProviderSymbols;
  derived?: Derived;
  /** words that link news to this asset */
  words?: string[];
}

export interface Interest {
  key: string;
  label: string;
  /** assets shown for this interest (keys) */
  assets: string[];
  /** no live price exists (real estate, land, deposits): Haru shows indexes, news and AI context */
  contextOnly?: boolean;
  note?: string;
  words: string[];
}

export interface Country {
  code: CountryCode;
  name: string;
  flag: string;
  currency: string;
  pulse: string[]; // headline strip: index, currency, gold
  interests: Interest[];
  words: string[];
}

const OZ = 31.1034768; // grams per troy ounce

const stockIN = (code: string, name: string, words: string[] = []): Asset => ({
  key: `IN:stock:${code}`,
  name,
  short: code,
  country: "IN",
  kind: "stock",
  currency: "INR",
  symbols: { av: `${code}.BSE`, eod: `${code}.NSE`, td: code, tdExchange: "NSE" },
  words: [name.toLowerCase(), code.toLowerCase(), ...words],
});
const etfIN = (code: string, name: string, words: string[] = []): Asset => ({ ...stockIN(code, name, words), key: `IN:etf:${code}`, kind: "etf" });
const stockCA = (code: string, name: string, words: string[] = []): Asset => ({
  key: `CA:stock:${code}`,
  name,
  short: code,
  country: "CA",
  kind: "stock",
  currency: "CAD",
  symbols: { av: `${code}.TRT`, eod: `${code}.TO`, td: code, tdExchange: "TSX" },
  words: [name.toLowerCase(), ...words],
});
const etfCA = (code: string, name: string, words: string[] = []): Asset => ({ ...stockCA(code, name, words), key: `CA:etf:${code}`, kind: "etf" });
const us = (code: string, name: string, kind: AssetKind = "stock", words: string[] = []): Asset => ({
  key: `WORLD:${kind}:${code}`,
  name,
  short: code,
  country: "WORLD",
  kind,
  currency: "USD",
  symbols: { td: code, av: code, eod: `${code}.US` },
  words: [name.toLowerCase(), ...words],
});
const pair = (key: string, name: string, td: string, kind: AssetKind, currency: string, unit?: string, words: string[] = []): Asset => ({
  key,
  name,
  short: td,
  country: "WORLD",
  kind,
  currency,
  unit,
  symbols: { td },
  words,
});

export const ASSETS: Asset[] = [
  // ---------- world building blocks (also used to derive local prices)
  pair("WORLD:metal:XAU", "Gold", "XAU/USD", "metal", "USD", "per oz", ["gold", "bullion"]),
  pair("WORLD:metal:XAG", "Silver", "XAG/USD", "metal", "USD", "per oz", ["silver"]),
  { ...pair("WORLD:fx:USDINR", "US dollar in rupees", "USD/INR", "fx", "INR", undefined, ["rupee", "usd/inr"]), symbols: { td: "USD/INR", bocRatio: ["FXUSDCAD", "FXINRCAD"] } },
  { ...pair("WORLD:fx:USDCAD", "US dollar in Canadian dollars", "USD/CAD", "fx", "CAD", undefined, ["loonie", "canadian dollar"]), symbols: { td: "USD/CAD", boc: "FXUSDCAD" } },
  { ...pair("WORLD:fx:EURUSD", "Euro in US dollars", "EUR/USD", "fx", "USD", undefined, ["euro"]), symbols: { td: "EUR/USD", bocRatio: ["FXEURCAD", "FXUSDCAD"] } },
  { ...pair("WORLD:fx:USDJPY", "US dollar in yen", "USD/JPY", "fx", "JPY", undefined, ["yen"]), symbols: { td: "USD/JPY", bocRatio: ["FXUSDCAD", "FXJPYCAD"] } },
  pair("WORLD:crypto:BTC", "Bitcoin", "BTC/USD", "crypto", "USD", undefined, ["bitcoin", "btc", "crypto"]),
  pair("WORLD:crypto:ETH", "Ethereum", "ETH/USD", "crypto", "USD", undefined, ["ethereum", "ether", "crypto"]),
  us("SPY", "S&P 500 (SPY)", "index", ["s&p 500", "wall street"]),
  us("QQQ", "Nasdaq 100 (QQQ)", "index", ["nasdaq"]),
  us("DIA", "Dow Jones (DIA)", "index", ["dow jones"]),
  us("AAPL", "Apple", "stock", ["iphone"]),
  us("MSFT", "Microsoft"),
  us("NVDA", "Nvidia", "stock", ["chips", "ai chips"]),
  us("AMZN", "Amazon"),
  us("GOOGL", "Alphabet (Google)", "stock", ["google"]),
  us("TSLA", "Tesla"),
  us("VOO", "Vanguard S&P 500 ETF", "etf"),
  us("VT", "Vanguard Total World ETF", "etf"),
  us("GLD", "SPDR Gold Shares", "etf", ["gold etf"]),

  // ---------- India
  { key: "IN:index:NIFTY", name: "Nifty 50", short: "NIFTY", country: "IN", kind: "index", currency: "INR", symbols: { eod: "NSEI.INDX" }, words: ["nifty", "निफ्टी"] },
  { key: "IN:index:SENSEX", name: "Sensex", short: "SENSEX", country: "IN", kind: "index", currency: "INR", symbols: { eod: "BSESN.INDX" }, words: ["sensex", "सेंसेक्स"] },
  stockIN("RELIANCE", "Reliance Industries", ["reliance", "ambani", "jio"]),
  stockIN("TCS", "Tata Consultancy Services", ["tcs"]),
  stockIN("HDFCBANK", "HDFC Bank", ["hdfc"]),
  stockIN("INFY", "Infosys"),
  stockIN("ICICIBANK", "ICICI Bank", ["icici"]),
  stockIN("SBIN", "State Bank of India", ["sbi"]),
  stockIN("BHARTIARTL", "Bharti Airtel", ["airtel"]),
  stockIN("ITC", "ITC"),
  stockIN("LT", "Larsen & Toubro", ["l&t"]),
  stockIN("TATAMOTORS", "Tata Motors"),
  etfIN("NIFTYBEES", "Nippon Nifty 50 BeES", ["nifty etf"]),
  etfIN("GOLDBEES", "Nippon Gold BeES", ["gold etf"]),
  etfIN("BANKBEES", "Nippon Bank BeES"),
  etfIN("JUNIORBEES", "Nippon Nifty Next 50 BeES"),
  {
    key: "IN:metal:GOLD10G",
    name: "Gold (24K spot)",
    short: "Gold",
    country: "IN",
    kind: "metal",
    currency: "INR",
    unit: "per 10 g",
    symbols: {},
    derived: { parts: [{ key: "WORLD:metal:XAU" }, { key: "WORLD:fx:USDINR" }], factor: 10 / OZ },
    words: ["gold", "सोना", "bullion", "gold price"],
  },
  {
    key: "IN:metal:SILVER1KG",
    name: "Silver (spot)",
    short: "Silver",
    country: "IN",
    kind: "metal",
    currency: "INR",
    unit: "per kg",
    symbols: {},
    derived: { parts: [{ key: "WORLD:metal:XAG" }, { key: "WORLD:fx:USDINR" }], factor: 1000 / OZ },
    words: ["silver", "चांदी"],
  },
  { key: "IN:fx:USDINR", name: "US dollar", short: "USD/INR", country: "IN", kind: "fx", currency: "INR", symbols: {}, derived: { parts: [{ key: "WORLD:fx:USDINR" }] }, words: ["rupee", "रुपया", "dollar"] },
  { key: "IN:fx:CADINR", name: "Canadian dollar", short: "CAD/INR", country: "IN", kind: "fx", currency: "INR", symbols: {}, derived: { parts: [{ key: "CA:fx:INRCAD:raw", invert: true }] }, words: ["rupee", "canadian dollar", "remittance"] },
  { key: "IN:crypto:BTC", name: "Bitcoin", short: "BTC", country: "IN", kind: "crypto", currency: "INR", symbols: {}, derived: { parts: [{ key: "WORLD:crypto:BTC" }, { key: "WORLD:fx:USDINR" }] }, words: ["bitcoin", "crypto"] },

  // ---------- Canada
  { key: "CA:index:TSX", name: "S&P/TSX Composite", short: "TSX", country: "CA", kind: "index", currency: "CAD", symbols: { eod: "GSPTSE.INDX" }, words: ["tsx", "toronto stock"] },
  stockCA("RY", "Royal Bank of Canada", ["rbc", "royal bank"]),
  stockCA("TD", "TD Bank", ["toronto-dominion", "td bank"]),
  stockCA("SHOP", "Shopify"),
  stockCA("ENB", "Enbridge"),
  stockCA("CNR", "CN Rail", ["canadian national"]),
  stockCA("BN", "Brookfield", ["brookfield"]),
  stockCA("BMO", "Bank of Montreal", ["bmo"]),
  stockCA("CNQ", "Canadian Natural Resources", ["canadian natural"]),
  stockCA("SU", "Suncor Energy", ["suncor"]),
  stockCA("BCE", "BCE (Bell)", ["bell canada"]),
  etfCA("XIU", "iShares S&P/TSX 60"),
  etfCA("VFV", "Vanguard S&P 500 (CAD)"),
  etfCA("XEQT", "iShares All-Equity ETF"),
  etfCA("VDY", "Vanguard Canadian High Dividend"),
  etfCA("ZEB", "BMO Equal Weight Banks"),
  etfCA("XAW", "iShares All-World ex Canada"),
  {
    key: "CA:metal:GOLDOZ",
    name: "Gold (spot)",
    short: "Gold",
    country: "CA",
    kind: "metal",
    currency: "CAD",
    unit: "per oz",
    symbols: {},
    derived: { parts: [{ key: "WORLD:metal:XAU" }, { key: "CA:fx:USDCAD" }] },
    words: ["gold", "bullion"],
  },
  { key: "CA:fx:USDCAD", name: "US dollar", short: "USD/CAD", country: "CA", kind: "fx", currency: "CAD", symbols: { boc: "FXUSDCAD", td: "USD/CAD" }, words: ["loonie", "canadian dollar"] },
  { key: "CA:fx:INRCAD", name: "100 Indian rupees", short: "INR/CAD ×100", country: "CA", kind: "fx", currency: "CAD", symbols: {}, derived: { parts: [{ key: "CA:fx:INRCAD:raw" }], factor: 100 }, words: ["rupee", "remittance"] },
  { key: "CA:fx:INRCAD:raw", name: "Indian rupee", short: "INR/CAD", country: "CA", kind: "fx", currency: "CAD", symbols: { boc: "FXINRCAD" } },
  { key: "CA:rate:POLICY", name: "Bank of Canada rate", short: "Policy rate", country: "CA", kind: "rate", currency: "%", unit: "%", symbols: { boc: "V39079" }, words: ["bank of canada", "interest rate", "rate cut", "rate hike"] },
  { key: "CA:rate:GOC5", name: "5-year Canada bond yield", short: "5Y yield", country: "CA", kind: "rate", currency: "%", unit: "%", symbols: { boc: "BD.CDN.5YR.DQ.YLD" }, words: ["bond yield", "mortgage rates", "gic"] },
  { key: "CA:rate:GOC10", name: "10-year Canada bond yield", short: "10Y yield", country: "CA", kind: "rate", currency: "%", unit: "%", symbols: { boc: "BD.CDN.10YR.DQ.YLD" }, words: ["bond yield"] },
  { key: "CA:crypto:BTC", name: "Bitcoin", short: "BTC", country: "CA", kind: "crypto", currency: "CAD", symbols: {}, derived: { parts: [{ key: "WORLD:crypto:BTC" }, { key: "CA:fx:USDCAD" }] }, words: ["bitcoin", "crypto"] },
];

export const ASSET_MAP = new Map(ASSETS.map((a) => [a.key, a]));

const W = {
  stocks: ["stock", "stocks", "shares", "equity", "equities", "market rally", "sell-off", "earnings", "ipo", "शेयर", "बाजार"],
  etf: ["etf", "index fund", "exchange-traded"],
  funds: ["mutual fund", "sip", "nav", "म्यूचुअल फंड"],
  gold: ["gold", "bullion", "सोना", "सोने"],
  silver: ["silver", "चांदी"],
  realEstate: ["real estate", "housing", "home prices", "house prices", "property", "mortgage", "rent", "rental", "condo", "homebuyers", "प्रॉपर्टी", "मकान"],
  land: ["land", "plot", "farmland", "acre", "zoning", "जमीन"],
  commercial: ["commercial property", "commercial real estate", "office space", "retail space", "shop", "shops", "warehouse", "mall", "दुकान"],
  deposits: ["fixed deposit", "fd rate", "ppf", "repo rate", "rbi", "savings rate", "interest rate", "ब्याज"],
  gic: ["gic", "bond", "yield", "interest rate", "bank of canada", "rate cut", "rate hike", "mortgage rate"],
  crypto: ["bitcoin", "crypto", "ethereum", "btc", "blockchain"],
  fx: ["rupee", "dollar", "currency", "exchange rate", "forex", "loonie", "रुपया", "remittance"],
  economy: ["economy", "inflation", "gdp", "recession", "tariff", "trade", "jobs report", "unemployment", "central bank", "fed", "federal reserve"],
};

export const COUNTRIES: Country[] = [
  {
    code: "IN",
    name: "India",
    flag: "🇮🇳",
    currency: "INR",
    pulse: ["IN:index:NIFTY", "IN:index:SENSEX", "IN:metal:GOLD10G", "IN:fx:USDINR", "IN:fx:CADINR"],
    words: ["india", "indian", "sensex", "nifty", "rbi", "rupee", "mumbai", "delhi", "bengaluru", "nse", "bse", "sebi", "भारत", "भारतीय", "मुंबई", "दिल्ली"],
    interests: [
      { key: "stocks", label: "Stocks", assets: ["IN:stock:RELIANCE", "IN:stock:TCS", "IN:stock:HDFCBANK", "IN:stock:INFY", "IN:stock:ICICIBANK", "IN:stock:SBIN", "IN:stock:BHARTIARTL", "IN:stock:ITC", "IN:stock:LT", "IN:stock:TATAMOTORS"], words: W.stocks },
      { key: "etf", label: "ETFs", assets: ["IN:etf:NIFTYBEES", "IN:etf:GOLDBEES", "IN:etf:BANKBEES", "IN:etf:JUNIORBEES"], words: W.etf },
      { key: "mutual_funds", label: "Mutual funds", assets: [], note: "Search any fund by name to see its NAV history (AMFI data).", words: W.funds },
      { key: "gold", label: "Gold", assets: ["IN:metal:GOLD10G", "IN:etf:GOLDBEES"], note: "Spot price from world gold and USD/INR. Jeweller rates add GST, making charges and local premiums.", words: W.gold },
      { key: "silver", label: "Silver", assets: ["IN:metal:SILVER1KG"], words: W.silver },
      { key: "real_estate", label: "Real estate", assets: [], contextOnly: true, note: "No live price exists for homes. Haru uses official house price indexes (RBI, NHB RESIDEX), news and your budget.", words: W.realEstate },
      { key: "land", label: "Land", assets: [], contextOnly: true, note: "Land prices are local and unlisted. Haru tracks news, policy and what fits your budget.", words: W.land },
      { key: "commercial", label: "Shops & commercial", assets: [], contextOnly: true, note: "Commercial property is priced deal by deal. Haru tracks rental yields, news and policy.", words: W.commercial },
      { key: "deposits", label: "FD & PPF", assets: [], contextOnly: true, note: "Deposit rates are set by each bank. Check your bank's current rate; Haru tracks RBI news.", words: W.deposits },
      { key: "crypto", label: "Crypto", assets: ["IN:crypto:BTC"], words: W.crypto },
      { key: "fx", label: "Rupee", assets: ["IN:fx:USDINR", "IN:fx:CADINR"], words: W.fx },
    ],
  },
  {
    code: "CA",
    name: "Canada",
    flag: "🇨🇦",
    currency: "CAD",
    pulse: ["CA:index:TSX", "CA:rate:POLICY", "CA:metal:GOLDOZ", "CA:fx:USDCAD", "CA:fx:INRCAD"],
    words: ["canada", "canadian", "tsx", "bank of canada", "toronto", "ottawa", "vancouver", "calgary", "edmonton", "alberta", "ontario", "loonie"],
    interests: [
      { key: "stocks", label: "Stocks", assets: ["CA:stock:RY", "CA:stock:TD", "CA:stock:SHOP", "CA:stock:ENB", "CA:stock:CNR", "CA:stock:BN", "CA:stock:BMO", "CA:stock:CNQ", "CA:stock:SU", "CA:stock:BCE"], words: W.stocks },
      { key: "etf", label: "ETFs", assets: ["CA:etf:XEQT", "CA:etf:VFV", "CA:etf:XIU", "CA:etf:VDY", "CA:etf:ZEB", "CA:etf:XAW"], note: "Popular for TFSA and RRSP accounts.", words: W.etf },
      { key: "gic", label: "GICs & bonds", assets: ["CA:rate:POLICY", "CA:rate:GOC5", "CA:rate:GOC10"], note: "Official Bank of Canada data. GIC rates follow the 1–5 year bond yields.", words: W.gic },
      { key: "gold", label: "Gold", assets: ["CA:metal:GOLDOZ", "WORLD:etf:GLD"], words: W.gold },
      { key: "real_estate", label: "Real estate", assets: ["CA:rate:GOC5"], contextOnly: true, note: "No live price exists for homes. Haru follows CREA and local market news, and the 5-year yield that drives fixed mortgage rates.", words: W.realEstate },
      { key: "land", label: "Land", assets: [], contextOnly: true, note: "Land is priced locally. Haru tracks zoning, development and price news.", words: W.land },
      { key: "commercial", label: "Shops & commercial", assets: [], contextOnly: true, note: "Commercial property is priced deal by deal. Haru tracks vacancy, rent and policy news.", words: W.commercial },
      { key: "crypto", label: "Crypto", assets: ["CA:crypto:BTC"], words: W.crypto },
      { key: "fx", label: "Dollar & rupee", assets: ["CA:fx:USDCAD", "CA:fx:INRCAD"], words: W.fx },
    ],
  },
  {
    code: "WORLD",
    name: "World",
    flag: "🌍",
    currency: "USD",
    pulse: ["WORLD:index:SPY", "WORLD:index:QQQ", "WORLD:metal:XAU", "WORLD:crypto:BTC", "WORLD:fx:EURUSD"],
    words: [],
    interests: [
      { key: "stocks", label: "US stocks", assets: ["WORLD:stock:AAPL", "WORLD:stock:MSFT", "WORLD:stock:NVDA", "WORLD:stock:AMZN", "WORLD:stock:GOOGL", "WORLD:stock:TSLA"], words: W.stocks },
      { key: "etf", label: "Index ETFs", assets: ["WORLD:index:SPY", "WORLD:index:QQQ", "WORLD:index:DIA", "WORLD:etf:VOO", "WORLD:etf:VT"], words: W.etf },
      { key: "gold", label: "Gold & silver", assets: ["WORLD:metal:XAU", "WORLD:metal:XAG", "WORLD:etf:GLD"], words: [...W.gold, ...W.silver] },
      { key: "crypto", label: "Crypto", assets: ["WORLD:crypto:BTC", "WORLD:crypto:ETH"], words: W.crypto },
      { key: "fx", label: "Currencies", assets: ["WORLD:fx:EURUSD", "WORLD:fx:USDJPY", "WORLD:fx:USDINR", "WORLD:fx:USDCAD"], words: W.fx },
      { key: "economy", label: "World economy", assets: [], contextOnly: true, note: "The biggest stories moving markets everywhere.", words: W.economy },
    ],
  },
];

export const COUNTRY_MAP = new Map(COUNTRIES.map((c) => [c.code, c]));

export function defaultInterests(code: CountryCode): string[] {
  return code === "IN" ? ["stocks", "gold", "real_estate", "fx"] : code === "CA" ? ["etf", "stocks", "gic", "real_estate"] : ["etf", "stocks", "gold", "economy"];
}

export function interestOf(code: CountryCode, key: string): Interest | undefined {
  return COUNTRY_MAP.get(code)?.interests.find((i) => i.key === key);
}
