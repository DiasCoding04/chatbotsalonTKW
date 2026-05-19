/** Salon: system prompt + catalog ảnh mẫu — dùng chung Training (browser) và inbox AI (server). */
export const SALON_SYSTEM =
  'Bạn là chuyên viên tư vấn khách hàng tại salon tóc (xưng em/con theo ngữ cảnh). Trả lời ngắn gọn, lịch sự, tiếng Việt. ' +
  'TUYỆT ĐỐI không để khách biết mình là AI, bot, trợ lý ảo, chatbot hay hệ thống tự động — luôn nói chuyện như nhân viên salon thật. ' +
  'Không dùng các cụm đó trong tin gửi khách; nếu khách hỏi có phải robot/AI không thì khẳng định em là tư vấn viên salon đang hỗ trợ, không giải thích kỹ thuật. ' +
  'TUYỆT ĐỐI không dùng từ "nhé" (cấm nhé chị, nhé em, nhé cô, nhé anh). ' +
  'Mọi câu hỏi khách phải kết ạ (cấm …nha chị?, cấm …cho chị nha chị). Câu mời/khẳng định: nha chị/nha em/nha cô/nha anh hoặc ạ; cấm nha chị ạ. ' +
  'Giúp khách đặt lịch, tư vấn dịch vụ và giá theo ngữ cảnh được cung cấp bên dưới. ' +
  'Khi khách gửi tin nhắn thoại/ghi âm (file âm thanh đính kèm), nghe và trả lời theo nội dung khách nói — không bỏ qua. ' +
  'Câu hỏi "Chị dự định ghé salon ngày nào và tầm mấy giờ" (và mọi biến thể có "lên lịch cho mình") chỉ được gửi tối đa 1 lần trong cả hội thoại — trước khi hỏi phải đọc tin salon đã gửi; đã hỏi rồi thì cấm lặp. ' +
  'Cấm hỏi ngày/giờ ghé khi khách chưa nêu dịch vụ cụ thể (mã giảm giá, ưu đãi chung…) — phải hỏi "Chị muốn tham khảo dịch vụ nào ạ" trước (luật 25 CONTEXT).'

export type BranchPage = {
  id: number
  name: string
  address: string
  /** SĐT quản lý chi nhánh — dùng khi khách xin Zalo/SĐT kết bạn. */
  hotline: string
}

const DEFAULT_MANAGER_ZALO = '0935311111'

export const BRANCH_PAGES: BranchPage[] = [
  { id: 1, name: 'CN 1 - Quận 1', address: '55 Phạm Viết Chánh, Cầu Ông Lãnh, Quận 1', hotline: '0906953297' },
  { id: 2, name: 'CN 2 - Bình Tân', address: '202-204 Vành Đai Trong, Bình Trị Đông B, Bình Tân', hotline: '0366860845' },
  { id: 3, name: 'CN 3 - Hóc Môn', address: '2/98A Lê Thị Hà, Hóc Môn', hotline: '0908329928' },
  { id: 4, name: 'CN 4 - Quận 12', address: '1078 Nguyễn Ảnh Thủ, Quận 12', hotline: '0326021580' },
  { id: 5, name: 'CN 5 - Gò Vấp', address: '397 Quang Trung, Phường 10, Gò Vấp', hotline: '0985388641' },
  { id: 6, name: 'CN 6 - Thủ Đức', address: '734A Kha Vạn Cân, Linh Đông, Thủ Đức', hotline: '0397717752' },
  { id: 7, name: 'CN 7 - Tân Phú', address: '109 Tân Sơn Nhì, Tân Sơn Nhì, Tân Phú', hotline: '0908197422' },
  { id: 8, name: 'CN 8 - Quận 9', address: '427 Man Thiện, Phường Tăng Nhơn Phú, Quận 9', hotline: DEFAULT_MANAGER_ZALO },
  { id: 9, name: 'CN 9 - Thủ Dầu Một', address: '238 Đại Lộ Bình Dương, Thủ Dầu Một', hotline: '0335581181' },
  { id: 10, name: 'CN 10 - Bến Cát', address: 'KDC Golden Centercity, Bến Cát', hotline: '0964773402' },
  { id: 11, name: 'CN 11 - Thuận An', address: 'Ô94, DC30, Đường D1, KDC Vietsing, Thuận An', hotline: '0348648396' },
  { id: 12, name: 'CN 12 - TÚ KA WA TRẢNG BÀNG', address: '24 Lãnh Binh Tòng, Trảng Bàng, Tây Ninh', hotline: '0939800339' },
  { id: 13, name: 'CN 13 - Biên Hòa', address: '1118 Nguyễn Ái Quốc, Tân Phong, Biên Hòa', hotline: '0344648899' },
  { id: 14, name: 'CN 14 - Phú Quốc', address: '120 Đường 30/4, TT Dương Đông, Phú Quốc', hotline: '0383554572' },
  { id: 15, name: 'CN 15 - Đà Lạt', address: '33 Phan Bội Châu, Phường 1, TP Đà Lạt', hotline: '0398707231' },
  { id: 16, name: 'CN 16 - Bình Phước', address: '483 Quốc Lộ 14, TX Đồng Xoài, Bình Phước', hotline: '0977877790' },
  { id: 17, name: 'CN 17 - TÚ KA WA TÂY NINH', address: '953 Cách Mạng Tháng 8, TP Tây Ninh', hotline: '0393734330' },
  { id: 18, name: 'CN 18 - Vũng Tàu', address: '496 Trương Công Định, Phường Vũng Tàu, TP.HCM', hotline: '0348648396' },
  { id: 19, name: 'CN 19 - Nha Trang', address: '150 Nguyễn Thị Minh Khai, Phường Nha Trang, Khánh Hòa', hotline: '0898888564' },
  { id: 20, name: 'CN 20 - Rạch Giá', address: '125 Trần Quang Khải, Phường Rạch Giá, An Giang', hotline: '0336536076' },
]

export function buildFanpagePrompt(branch: BranchPage): string {
  return [
    '--- Fanpage/chi nhánh đang nhắn ---',
    `Khách đang nhắn fanpage ${branch.name}.`,
    `Địa chỉ mặc định của fanpage này: ${branch.address}.`,
    `SĐT quản lý chi nhánh (Zalo/kết bạn): ${branch.hotline}. Khi khách xin Zalo, SĐT, số kết bạn, add Zalo → gửi đúng số này.`,
    'Chỉ gửi địa chỉ chi nhánh mặc định khi khách hỏi địa chỉ/chi nhánh, hỏi salon ở đâu, cần đến salon kiểm tra, hoặc đã rõ dịch vụ + thời gian và cần xác nhận nơi ghé.',
    'Khách chỉ nói "ghé", "chiều ghé", "tối ghé" là tín hiệu đặt lịch, không phải tín hiệu hỏi địa chỉ; khi chưa rõ dịch vụ/kiểu thì chỉ hỏi dịch vụ/kiểu còn thiếu, không tự đưa địa chỉ.',
    'Khi gửi địa chỉ mặc định, phải hỏi khách có tiện qua địa chỉ đó không (kết ạ — cấm …nha chị?).',
    'Nếu khách nói xa quá: nêu lý do xứng đáng để khách cân nhắc bỏ thời gian ghé (kỹ thuật xử lý, tư vấn trực tiếp, sản phẩm tốt, bảo hành/ưu đãi phù hợp).',
    'Nếu khách vẫn không tiện: hỏi khu vực/địa chỉ của khách và tư vấn chi nhánh gần nhất theo danh sách chi nhánh trong CONTEXT.md.',
  ].join('\n')
}

export type ImageSampleGroup = {
  key: string
  label: string
  usage: string
  urls: string[]
}

export const IMAGE_SAMPLE_MARKER_RE = /\[\[\s*SEND_IMAGE\s*:\s*([a-z0-9_-]+)\s*\]\]/gi

/** Giới hạn ảnh gửi mỗi nhóm mỗi lượt (Messenger gửi từng ảnh một tin). */
export const DEFAULT_MAX_IMAGE_SAMPLES_PER_REPLY = 6

/** Marker keys cũ → key hiện tại (giữ tương thích [[SEND_IMAGE:...]] đã lưu). */
export const IMAGE_SAMPLE_LEGACY_KEYS: Record<string, string> = {
  noi_long_vu_den_chum_den: 'noi_long_vu_den',
}

export const IMAGE_SAMPLE_ALIASES: Record<string, string[]> = {
  moi_noi_long_vu: ['moi noi long vu', 'hinh moi noi', 'mau moi noi'],
  noi_toc: ['noi toc', 'mau noi toc', 'toc noi'],
  noi_long_vu_den: [
    'noi long vu den',
    'toc noi den',
    'toc noi mau den',
    'noi toc den',
    'noi toc mau den',
  ],
  toc_ngan_bob_tem: ['toc ngan', 'bob', 'toc tem', 'mau tem'],
  mai_thua: ['mai thua'],
  mai_bay: ['mai bay'],
  mai_phap: ['mai phap'],
  mai_ngang: ['mai ngang'],
  duoi_ngan: ['duoi cup toc ngan', 'duoi thang toc ngan', 'toc ngan ngang vai'],
  duoi_dai: ['duoi cup toc dai', 'duoi thang toc dai'],
  uon_cup: ['uon cup'],
  uon_song_ngan: ['uon song toc ngan', 'uon song ngan'],
  uon_song_dai: ['uon song toc dai', 'uon song dai'],
  uon_hippie: ['uon hippie', 'uon hippi', 'uon hippe', 'xu mi'],
  uon_xoan_tang: ['uon xoan tang', 'xoan tang'],
  uon_xoan_luoi_dai: ['uon xoan luoi dai', 'xoan luoi toc dai', 'uon loi toc dai'],
  uon_xoan_luoi_ngan: ['uon xoan luoi ngan', 'xoan luoi toc ngan', 'uon loi toc ngan'],
  nhuom_phu_bac: ['nhuom phu bac'],
  phu_bac_mau_tram: ['phu bac mau tram', 'nhuom phu bac mau tram'],
  toc_bac: ['toc bac', 'mau cho toc bac'],
  mau_tram: ['mau tram', 'mau toi nhe'],
  // Không alias "mau noi" — trùng âm «mẫu nối» (extension) sau normalize; chỉ cụm rõ tiếng Việt ở inferPrimaryImageSampleKey.
  mau_thoi_trang: ['mau thoi trang', 'mau neon', 'mau ca tinh'],
  mau_balayage: ['balayage'],
  mau_babylight: ['baby light', 'babylight'],
  nhuom_sang_khong_tay: ['nhuom sang khong can tay', 'mau sang khong tay', 'nhuom khong tay'],
}

/** Khách phàn nàn / từ chối ảnh, hoặc model hứa không gửi thêm — không được gửi ảnh mẫu. */
export function shouldBlockImageSampleSend(...textParts: string[]): boolean {
  const normalized = normalizeSearchText(textParts.filter(Boolean).join('\n'))
  if (!normalized) return false

  if (
    /(khong gui them anh|khong gui anh nua|se khong gui.*anh|dung gui anh|thoi gui anh|xin loi.*gui anh|lam phien)/.test(
      normalized,
    )
  ) {
    return true
  }
  if (
    /(gui anh nhieu|anh nhieu lan|spam anh|cung gui anh|cu gui anh|tai sao.*gui.*anh|vi sao.*gui.*anh)/.test(
      normalized,
    )
  ) {
    return true
  }
  return false
}

export function isExplicitImageSampleRequest(text: string): boolean {
  if (shouldBlockImageSampleSend(text)) return false

  const lower = text.toLowerCase()
  if (
    /(xem mẫu|xem mau|gửi mẫu|gui mau|gửi hình|gui hinh|cho xem mẫu|cho xem mau|muốn xem|muon xem|có hình mẫu|co hinh mau|tham khảo mẫu|tham khao mau)/i.test(
      lower,
    )
  ) {
    return true
  }
  if (/(tham khảo|tham khao|cho xem|có hình|co hinh|có ảnh|co anh)/i.test(lower)) {
    return true
  }

  // "mẫu" alone — not when complaining (nhieu lan, spam, phiền).
  if (/\bmẫu\b/i.test(lower) && !/(nhieu|lan|spam|phiền|phien|làm phiền)/i.test(lower)) {
    return true
  }
  return false
}

function hasAnyWord(text: string, words: string[]): boolean {
  return words.some((word) => new RegExp(`\\b${word}\\b`).test(text))
}

function inferPrimaryImageSampleKey(text: string): string | null {
  const normalized = normalizeSearchText(text)
  if (!normalized) return null

  const has = (word: string) => new RegExp(`\\b${word}\\b`).test(normalized)
  const hasAny = (words: string[]) => hasAnyWord(normalized, words)
  const isShort = hasAny(['ngan', 'ngang vai', 'bob', 'tem'])
  const isLong = hasAny(['dai', 'qua vai', 'ngang lung', 'cham lung', 'cham mong', 'toi mong'])
  const hasChemicalService = hasAny(['uon', 'duoi', 'nhuom', 'noi'])

  /** «mẫu nối / nối tóc …» không phụ thuộc biến thể không dấu; tránh lẫn với «màu nổi» (normalize thành cùng dạng âm tiết). */
  const wantsExtensionHairSample =
    /\bmẫu\s+nối\b|\bxem\s+mẫu\s+nối\b|\bgửi\s+mẫu\s+nối\b|\bhình\s+(?:mẫu\s+)?nối(?:\s+tóc)?\b|\bmối\s+nối\b|\bnối\s+tóc\b/i.test(text)
  if (wantsExtensionHairSample && !/\blông\s*vũ\b/i.test(text) && !/\blong vu\b/i.test(normalized)) {
    return 'noi_toc'
  }

  if (
    normalized.includes('noi long vu den') ||
    normalized.includes('toc noi den') ||
    normalized.includes('toc noi mau den') ||
    normalized.includes('noi toc den') ||
    normalized.includes('noi toc mau den')
  ) {
    return 'noi_long_vu_den'
  }
  /** Lông vũ (ưu tiên nhóm mối nối sau khi đã loại đen ở trên). */
  if (normalized.includes('moi noi long vu')) return 'moi_noi_long_vu'
  if (/\blông\s*vũ\b/i.test(text) || normalized.includes('noi long vu') || normalized.includes('long vu')) {
    return 'moi_noi_long_vu'
  }
  if (normalized.includes('noi toc') || normalized.includes('toc noi')) return 'noi_toc'

  if (has('phu') && has('bac') && has('tram')) return 'phu_bac_mau_tram'
  if (normalized.includes('nhuom phu bac') || (has('phu') && has('bac'))) return 'nhuom_phu_bac'
  if (isSilverCoverageContext(normalized)) return 'toc_bac'

  if (normalized.includes('mai thua')) return 'mai_thua'
  if (normalized.includes('mai bay')) return 'mai_bay'
  if (normalized.includes('mai phap')) return 'mai_phap'
  if (normalized.includes('mai ngang')) return 'mai_ngang'

  if (has('duoi') && isShort) return 'duoi_ngan'
  if (has('duoi') && isLong) return 'duoi_dai'
  if (normalized.includes('uon cup')) return 'uon_cup'
  if (normalized.includes('uon song') && isShort) return 'uon_song_ngan'
  if (normalized.includes('uon song') && isLong) return 'uon_song_dai'
  if (hasAny(['hippie', 'hippi', 'hippe']) || normalized.includes('xu mi')) return 'uon_hippie'
  if (normalized.includes('xoan tang')) return 'uon_xoan_tang'
  if ((normalized.includes('xoan luoi') || normalized.includes('uon loi')) && isShort) {
    return 'uon_xoan_luoi_ngan'
  }
  if ((normalized.includes('xoan luoi') || normalized.includes('uon loi')) && isLong) {
    return 'uon_xoan_luoi_dai'
  }

  if ((normalized.includes('toc ngan') || has('bob') || has('tem')) && !hasChemicalService) {
    return 'toc_ngan_bob_tem'
  }

  if (has('balayage')) return 'mau_balayage'
  if (normalized.includes('baby light') || has('babylight')) return 'mau_babylight'
  if (normalized.includes('sang khong') || normalized.includes('khong can tay')) {
    return 'nhuom_sang_khong_tay'
  }
  /** Màu thời trang / «màu nổi» — chỉ cụm rõ; không dùng substring normalize 'mau noi' vì nhầm «mẫu nối». */
  if (normalized.includes('mau thoi trang')) return 'mau_thoi_trang'
  if (/\bmàu\s+nổi\b/i.test(text)) {
    return 'mau_thoi_trang'
  }
  /** «cá tính» chỉ vào dye khi có tín hiệu nhuộm/màu nổi bật. */
  if (
    has('ca tinh') &&
    /\b(nhuom|babylight|balayage|highlight|neon|dip|ombre|galaxy|ruc|thi kieu|mau neon|hong|cam|tim|xanh|tim vang|ruc roi)\b/i.test(normalized)
  ) {
    return 'mau_thoi_trang'
  }
  if (normalized.includes('mau tram') || normalized.includes('mau toi nhe')) return 'mau_tram'

  return null
}

export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function slugifyImageSampleLabel(label: string): string {
  const normalized = normalizeSearchText(label)
  return (
    normalized
      .replace(/\b(url|anh|mau|dung|khi|khach|hoi|xem)\b/g, ' ')
      .replace(/\s+/g, '_')
      .replace(/^_+|_+$/g, '') || 'image_sample'
  )
}

export function imageSampleKeyForLabel(label: string): string {
  const normalized = normalizeSearchText(label)
  if (normalized.includes('moi noi long vu')) return 'moi_noi_long_vu'
  if (normalized.includes('noi long vu den')) return 'noi_long_vu_den'
  if (normalized.includes('noi toc')) return 'noi_toc'
  if (normalized.includes('duoi') && normalized.includes('ngan')) return 'duoi_ngan'
  if (normalized.includes('duoi') && normalized.includes('dai')) return 'duoi_dai'
  if (normalized.includes('uon cup')) return 'uon_cup'
  if (normalized.includes('uon song') && normalized.includes('ngan')) return 'uon_song_ngan'
  if (normalized.includes('uon song') && normalized.includes('dai')) return 'uon_song_dai'
  if (normalized.includes('hippie') || normalized.includes('hippi') || normalized.includes('hippe') || normalized.includes('xu mi')) {
    return 'uon_hippie'
  }
  if (normalized.includes('xoan tang')) return 'uon_xoan_tang'
  if (normalized.includes('xoan luoi') && normalized.includes('dai')) return 'uon_xoan_luoi_dai'
  if (normalized.includes('xoan luoi') && normalized.includes('ngan')) return 'uon_xoan_luoi_ngan'
  if (normalized.includes('toc ngan') || normalized.includes('bob') || normalized.includes('tem')) {
    return 'toc_ngan_bob_tem'
  }
  if (normalized.includes('mai thua')) return 'mai_thua'
  if (normalized.includes('mai bay')) return 'mai_bay'
  if (normalized.includes('mai phap')) return 'mai_phap'
  if (normalized.includes('mai ngang')) return 'mai_ngang'
  if (normalized.includes('phu bac') && normalized.includes('mau tram')) return 'phu_bac_mau_tram'
  if (normalized.includes('nhuom phu bac')) return 'nhuom_phu_bac'
  if (normalized.includes('toc bac')) return 'toc_bac'
  if (normalized.includes('mau tram')) return 'mau_tram'
  if (normalized.includes('mau thoi trang')) return 'mau_thoi_trang'
  if (normalized.includes('balayage')) return 'mau_balayage'
  if (normalized.includes('baby light') || normalized.includes('babylight')) return 'mau_babylight'
  if (normalized.includes('sang khong') || normalized.includes('khong can tay')) return 'nhuom_sang_khong_tay'
  return slugifyImageSampleLabel(label)
}

export function extractImageSampleUrls(text: string): string[] {
  return Array.from(
    new Set(
      text.match(/(?:https?:\/\/[^\s),\]]+|(?:\.?\/)?images\/samples\/[^\s),\]]+)/g) ?? [],
    ),
  )
}

function normalizePublicImageBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl ?? '').trim()
  if (!raw) return ''
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const u = new URL(withProtocol)
    u.hash = ''
    u.search = ''
    return u.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

export function resolveImageSampleUrl(rawUrl: string, baseUrl?: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed

  const base = normalizePublicImageBaseUrl(baseUrl)
  if (!base) return trimmed

  const cleanPath = trimmed.replace(/^\.?\/*/, '')
  return `${base}/${cleanPath}`
}

export function parseImageSampleGroups(markdown: string): ImageSampleGroup[] {
  const groups: ImageSampleGroup[] = []
  const seenKeys = new Set<string>()
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^- URL\s+(.+?)\s+\((.+?)\):\s*(.+)$/)
    if (!match) continue
    const [, rawLabel, rawUsage, urlText] = match
    const urls = extractImageSampleUrls(urlText)
    if (!urls.length) continue
    const label = rawLabel.trim().replace(/^ảnh mẫu\s+/i, '')
    const usage = rawUsage.trim()
    const baseKey = imageSampleKeyForLabel(label)
    let key = baseKey
    let suffix = 2
    while (seenKeys.has(key)) {
      key = `${baseKey}_${suffix}`
      suffix += 1
    }
    seenKeys.add(key)
    groups.push({ key, label, usage, urls })
  }
  return groups
}

export function buildImageSampleCatalogPrompt(groups: ImageSampleGroup[]): string {
  if (!groups.length) return ''
  return [
    '--- IMAGE SAMPLE ROUTER (không chứa URL) ---',
    'App có database URL ảnh mẫu riêng, URL không nằm trong prompt để tiết kiệm chi phí.',
    'Khi nhu cầu khách khớp rõ với đúng một nhóm ảnh, có thể chủ động thêm marker đúng nhóm ở một dòng riêng: [[SEND_IMAGE:key]].',
    'Messenger/Inbox — chế độ nghiêm: máy chủ chỉ giữ marker nếu key trùng đúng với một nhóm mà máy chỉ suy được từ tin khách; marker sai nhóm hoặc khách chỉ xin xem mẫu chung (không rõ kiểu/dịch vụ/nhuộm) thì không gửi ảnh — hướng dẫn chị nói cụ thể vd sóng ngắn/dài, uốn cụp, balayage, phủ bạc…',
    'Không tự viết URL, không giải thích marker cho khách. App sẽ ẩn marker và thay bằng link ảnh thật.',
    'Dùng tối đa 1 marker/lượt; chỉ dùng khi chắc đúng loại tóc/dịch vụ/màu khách đang hỏi — nghiêm không đoán mò.',
    'TUYỆT ĐỐI không dùng marker khi khách phàn nàn gửi ảnh nhiều/làm phiền, hoặc khi em đã nói sẽ không gửi thêm ảnh.',
    'Khi ngữ cảnh là phủ bạc / tóc bạc / hòa bạc / nuôi bạc, chỉ dùng nhuom_phu_bac, phu_bac_mau_tram hoặc toc_bac; tuyệt đối không dùng mau_tram.',
    'Các key ảnh mẫu:',
    ...groups.map((group) => `- ${group.key}: ${group.label} (${group.usage})`),
  ].join('\n')
}

export function mergeContextWithImageSampleCatalog(
  contextMd: string,
  imageSampleGroups: ImageSampleGroup[],
): string {
  const context = contextMd.trim()
  const imageCatalog = buildImageSampleCatalogPrompt(imageSampleGroups)
  if (!imageCatalog) return context
  return `${context}\n\n${imageCatalog}`.trim()
}

export function compactLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.trim() || (index > 0 && index < lines.length - 1))
    .join('\n')
    .trim()
}

export function inferImageSampleKeys(text: string, groups: ImageSampleGroup[]): string[] {
  if (!isExplicitImageSampleRequest(text)) return []

  const normalized = normalizeSearchText(text)
  const primaryKey = inferPrimaryImageSampleKey(text)
  if (primaryKey && groups.some((group) => group.key === primaryKey)) return [primaryKey]

  const keys: string[] = []
  for (const group of groups) {
    const aliases = IMAGE_SAMPLE_ALIASES[group.key] ?? [
      normalizeSearchText(group.label),
      normalizeSearchText(group.usage),
    ]
    if (aliases.some((alias) => alias && normalized.includes(alias))) {
      keys.push(group.key)
    }
    if (keys.length >= 1) break
  }
  return keys
}

/** Chế độ nghiêm: chỉ được gửi ảnh khi tin khách yêu cầu xem mẫu rõ và suy được đúng 1 nhóm (~key) — không đoán, không chồng nhóm. */
export function resolveApprovedImageSampleKeys(triggerText: string, groups: ImageSampleGroup[]): string[] {
  if (!triggerText.trim()) return []
  if (shouldBlockImageSampleSend(triggerText)) return []
  const keys = inferImageSampleKeys(triggerText, groups)
  if (keys.length !== 1) return []
  return keys
}

export function isSilverCoverageContext(text: string): boolean {
  const normalized = normalizeSearchText(text)
  return /\b(phu bac|toc bac|bac trang|nhieu bac|hoa bac|nuoi bac)\b/.test(normalized)
}

export function filterImageSampleKeysForContext(keys: string[], contextText: string): string[] {
  if (!isSilverCoverageContext(contextText)) return keys
  return keys.filter((key) => key !== 'mau_tram')
}

export function expandModelImageSampleMarkers(
  rawText: string,
  groups: ImageSampleGroup[],
  triggerText: string,
  /** Inbox Facebook: không tự suy nhóm ảnh từ tin khách — chỉ gửi khi model có [[SEND_IMAGE:key]]. */
  opts?: {
    inferImageKeysFromModelOnly?: boolean
    /** Nếu truyền (kể cả []): chỉ giữ marker khi key ∈ danh sách này; không đoán thêm ảnh từ model. Facebook inbox = chế độ nghiêm. */
    enforceCustomerApprovedKeys?: string[]
    imageBaseUrl?: string
    maxImagesPerGroup?: number
  },
): { apiText: string; displayText: string; imageUrls: string[] } {
  const groupsByKey = new Map(groups.map((group) => [group.key, group]))
  for (const [legacyKey, currentKey] of Object.entries(IMAGE_SAMPLE_LEGACY_KEYS)) {
    const group = groupsByKey.get(currentKey)
    if (group) groupsByKey.set(legacyKey, group)
  }
  const maxPerGroup = Math.max(
    1,
    Math.min(8, opts?.maxImagesPerGroup ?? DEFAULT_MAX_IMAGE_SAMPLES_PER_REPLY),
  )
  const contextBlob = `${triggerText}\n${rawText}`
  if (shouldBlockImageSampleSend(triggerText, rawText)) {
    const cleanText = compactLines(rawText.replace(IMAGE_SAMPLE_MARKER_RE, ''))
    return { apiText: cleanText, displayText: cleanText, imageUrls: [] }
  }

  const markerKeys: string[] = []
  let hadMarker = false
  const textWithoutMarkers = rawText.replace(IMAGE_SAMPLE_MARKER_RE, (_marker, rawKey: string) => {
    hadMarker = true
    const key = rawKey.trim().toLowerCase()
    if (groupsByKey.has(key) && !markerKeys.includes(key)) markerKeys.push(key)
    return ''
  })

  const enforced = opts?.enforceCustomerApprovedKeys
  /** Khi không nghiêm: key suy được từ khách để ghép vào luồng cũ. */
  const customerKeysFallback =
    enforced === undefined && !opts?.inferImageKeysFromModelOnly
      ? filterImageSampleKeysForContext(inferImageSampleKeys(triggerText, groups), triggerText)
      : []

  let validMarkerKeys: string[]
  if (enforced !== undefined) {
    validMarkerKeys =
      enforced.length === 0
        ? []
        : markerKeys.filter((key) => groupsByKey.has(key) && enforced.includes(key))
  } else {
    validMarkerKeys = markerKeys.filter(
      (key) =>
        groupsByKey.has(key) &&
        (!customerKeysFallback.length || customerKeysFallback.includes(key)),
    )
  }

  /** Chế độ nghiêm: model quên marker nhưng khách đã nói rõ 1 nhóm → thêm đúng key đó (không bù khi model trả sai key). */
  if (
    enforced &&
    enforced.length === 1 &&
    validMarkerKeys.length === 0 &&
    markerKeys.length === 0
  ) {
    validMarkerKeys = [...enforced]
  }

  /** Chế độ nghiêm: không tự thêm bundle ảnh nếu model không đặt marker khớp. */
  let autoKeys: string[]
  if (markerKeys.length > 0) autoKeys = []
  else if (enforced !== undefined) autoKeys = []
  else if (opts?.inferImageKeysFromModelOnly) autoKeys = []
  else autoKeys = customerKeysFallback

  const keys = filterImageSampleKeysForContext(
    [...validMarkerKeys, ...autoKeys].filter((key, index, arr) => arr.indexOf(key) === index),
    contextBlob,
  )
  if (!keys.length) {
    const cleanText = hadMarker ? compactLines(textWithoutMarkers) : rawText
    return { apiText: cleanText, displayText: cleanText, imageUrls: [] }
  }

  const baseText = compactLines(textWithoutMarkers)
  const displayAdditions: string[] = []
  const imageUrls: string[] = []
  const seenUrl = new Set<string>()
  for (const key of keys) {
    const group = groupsByKey.get(key)
    if (!group) continue
    const resolvedUrls = group.urls
      .slice(0, maxPerGroup)
      .map((u) => resolveImageSampleUrl(u, opts?.imageBaseUrl))
      .filter((u) => u.length > 0)
    displayAdditions.push([`Ảnh mẫu ${group.label}:`, ...resolvedUrls].join('\n'))
    for (const u of resolvedUrls) {
      const t = u.trim()
      if (!t || seenUrl.has(t)) continue
      if (imageUrls.length >= maxPerGroup) break
      seenUrl.add(t)
      imageUrls.push(t)
    }
    if (imageUrls.length >= maxPerGroup) break
  }

  return {
    apiText: baseText,
    displayText: compactLines([baseText, ...displayAdditions].filter(Boolean).join('\n')),
    imageUrls,
  }
}

const SALON_TIMEZONE = 'Asia/Ho_Chi_Minh'

/** Gắn thời gian VN + hạn ưu đãi T7/CN (tuần này vs tuần sau) vào block SYSTEM CONTEXT. */
export function injectRealtimeSystemContext(contextMd: string, now = new Date()): string {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: SALON_TIMEZONE, weekday: 'short' }).format(now)
  const isSatOrSun = weekday === 'Sat' || weekday === 'Sun'
  const timeLabel = new Intl.DateTimeFormat('vi-VN', {
    timeZone: SALON_TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
  const promoDeadline = isSatOrSun
    ? 'Chương trình ưu đãi này đến hết thứ 7, chủ nhật tuần sau nha chị'
    : 'Chương trình ưu đãi này đến hết thứ 7, chủ nhật tuần này nha chị'

  let out = contextMd
  out = out.replace(
    /^- Thời gian hiện tại:.*$/m,
    `- Thời gian hiện tại: ${timeLabel} (${SALON_TIMEZONE.replace('_', ' ')})`,
  )
  out = out.replace(
    /^- Lưu ý thời gian:.*$/m,
    `- Lưu ý thời gian: **Thứ 7 hoặc Chủ nhật** (theo múi giờ VN) → hạn ưu đãi **tuần sau**; **Thứ 2–Thứ 6** → **tuần này**. **Cấm** nói "tuần này" khi hôm nay là T7/CN.\n- Hạn ưu đãi (theo thời gian thực): **${promoDeadline}** — dùng nguyên cụm này khi báo hạn (KNOWLEDGE 2); **tối đa 1 lần / hội thoại** (đọc tin salon đã gửi — đã có thì **cấm** lặp); **cấm** đổi sang "tuần này" nếu block trên ghi tuần sau.`,
  )
  return out
}

/** Prompt cache Context API — không gắn giờ/phút (tránh tạo cache mới mỗi phút). */
export function buildSalonSystemPromptStatic(contextMd: string, branch: BranchPage): string {
  const trimmed = contextMd.trim()
  const fanpagePrompt = buildFanpagePrompt(branch)
  if (!trimmed) return `${SALON_SYSTEM}\n\n${fanpagePrompt}`
  return `${SALON_SYSTEM}\n\n${fanpagePrompt}\n\n--- Ngữ cảnh salon (CONTEXT.md) ---\n\n${trimmed}`
}

/** Block ngắn gửi kèm mỗi lượt generate (không nằm trong cache). */
export function buildRealtimeContextBlock(now = new Date()): string {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: SALON_TIMEZONE, weekday: 'short' }).format(now)
  const isSatOrSun = weekday === 'Sat' || weekday === 'Sun'
  const timeLabel = new Intl.DateTimeFormat('vi-VN', {
    timeZone: SALON_TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
  const promoDeadline = isSatOrSun
    ? 'Chương trình ưu đãi này đến hết thứ 7, chủ nhật tuần sau nha chị'
    : 'Chương trình ưu đãi này đến hết thứ 7, chủ nhật tuần này nha chị'
  return [
    '[CONTEXT THỰC TẾ — áp dụng cho lượt trả lời này]',
    `- Thời gian hiện tại: ${timeLabel} (${SALON_TIMEZONE.replace('_', ' ')})`,
    `- Hạn ưu đãi khi báo giá: **${promoDeadline}** (T7/CN → tuần sau; T2–T6 → tuần này; cấm "tuần này" khi hôm nay là T7/CN)`,
  ].join('\n')
}

export type MinimalChatTurn = { role: 'user' | 'model'; text: string }

/** Đưa giờ/hạn ưu đãi vào history — không đưa vào cached system prompt. */
export function prependRealtimeContextTurns(history: MinimalChatTurn[]): MinimalChatTurn[] {
  const block = buildRealtimeContextBlock()
  return [
    { role: 'user', text: block },
    { role: 'model', text: 'Dạ em đã nắm thời gian và hạn ưu đãi hiện tại ạ.' },
    ...history,
  ]
}

/** Đầy đủ (có inject vào CONTEXT) — dùng ước token UI; cache API dùng `buildSalonSystemPromptStatic`. */
export function buildSalonSystemPrompt(contextMd: string, branch: BranchPage): string {
  const trimmed = injectRealtimeSystemContext(contextMd.trim())
  const fanpagePrompt = buildFanpagePrompt(branch)
  if (!trimmed) return `${SALON_SYSTEM}\n\n${fanpagePrompt}`
  return `${SALON_SYSTEM}\n\n${fanpagePrompt}\n\n--- Ngữ cảnh salon (CONTEXT.md) ---\n\n${trimmed}`
}

export const PLACEHOLDER_NO_TEXT = '[Tin nhắn không có nội dung text]'
export const PLACEHOLDER_REFERRAL = '[Khách mở hội thoại từ nguồn referral]'

export function isSalonPlaceholderMessageText(text: string): boolean {
  const t = text.trim()
  return t === PLACEHOLDER_NO_TEXT || t === PLACEHOLDER_REFERRAL
}

/** Chuẩn hóa để phát hiện lặp câu hỏi ngày/giờ ghé (luật 21 CONTEXT). */
function normalizeScheduleAskCheckText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const BLOCKED_SCHEDULE_ASK_LINE_RE = [
  /du dinh ghe salon.*ngay nao.*may gio/,
  /du dinh ghe salon.*ngay nao/,
  /du dinh ghe.*khi nao/,
  /ngay nao va tam may gio/,
  /ngay nao va tam may gio.*len lich/,
  /ghe salon ngay nao va tam may gio/,
  /tam may gio de em len lich/,
  /len lich cho minh/,
  /de em len lich cho minh/,
]

const CUSTOMER_SERVICE_INTENT_RE = [
  /\buon\b/,
  /\bduoi\b/,
  /\bnhuom\b/,
  /\bnoi\b/,
  /\blong vu\b/,
  /\bcat\b/,
  /\bgoi\b/,
  /\btay\b/,
  /\bbalayage\b/,
  /\bbabylight\b/,
  /\bbaby light\b/,
  /\bhippie\b/,
  /\bhippi\b/,
  /\bhippe\b/,
  /\bxu mi\b/,
  /\bsong\b/,
  /\bxoan\b/,
  /\bluoi\b/,
  /\btem\b/,
  /\bbob\b/,
  /\bmai thua\b/,
  /\bmai bay\b/,
  /\bmai phap\b/,
  /\bmai ngang\b/,
  /\bphu bac\b/,
  /\bphu bac\s/,  // Match "phu bac" ngay cả khi có từ sau (không cần word boundary cuối)
  /\bhighlight\b/,
  /\bphuc hoi\b/,
  /\bphong chan\b/,
  /\bbam\b/,
  /\bthao noi\b/,
  /\bnang noi\b/,
  /\bmau\b/,
  /\b(50|60|70|80)\s*cm\b/,
]

const ASK_SERVICE_LINE_RE = [
  /muon tham khao dich vu nao/,
  /quan tam.*(uon|duoi|nhuom|noi)/,
  /muon lam (gi|dich vu nao)/,
]

export const ASK_SERVICE_FALLBACK_LINE = 'Dạ chị muốn tham khảo dịch vụ nào ạ'

/** Khách đã nêu tên dịch vụ/kiểu (không chỉ mã giảm giá/ưu đãi chung). */
export function customerTextIndicatesService(text: string): boolean {
  const n = normalizeScheduleAskCheckText(text)
  if (!n) return false
  return CUSTOMER_SERVICE_INTENT_RE.some((re) => re.test(n))
}

export function conversationCustomerHasNamedService(
  messages: Array<{ author: string; text: string }>,
  isCustomer: (author: string) => boolean,
): boolean {
  return messages.some((m) => isCustomer(m.author) && customerTextIndicatesService(m.text))
}

export function lineLooksLikeAskService(line: string): boolean {
  const n = normalizeScheduleAskCheckText(line)
  if (!n) return false
  return ASK_SERVICE_LINE_RE.some((re) => re.test(n))
}

/** Gỡ hỏi lịch khi khách chưa nêu dịch vụ cụ thể (luật 25). */
export function filterPrematureScheduleAskLines(
  lines: string[],
  customerHasNamedService: boolean,
): string[] {
  if (customerHasNamedService) return lines
  return lines.filter((line) => !lineLooksLikeBlockedScheduleAsk(line))
}

/**
 * Sau khi gỡ hỏi lịch sớm: chỉ thêm «tham khảo dịch vụ nào» khi không còn dòng nào.
 * Không dí câu đó vào tin địa chỉ / giải thích khuyến mãi / trả lời đã đủ ngữ cảnh.
 */
export function ensureAskServiceLineWhenNeeded(
  lines: string[],
  customerHasNamedService: boolean,
): string[] {
  if (customerHasNamedService) return lines
  if (lines.some((line) => lineLooksLikeAskService(line))) return lines
  const trimmed = lines.map((l) => l.trim()).filter(Boolean)
  if (trimmed.length > 0) return trimmed
  return [ASK_SERVICE_FALLBACK_LINE]
}

/** Câu hỏi lịch dài "ngày nào + mấy giờ + lên lịch" — chỉ được 1 lần/hội thoại. */
export function lineLooksLikeBlockedScheduleAsk(line: string): boolean {
  const n = normalizeScheduleAskCheckText(line)
  if (!n) return false
  return BLOCKED_SCHEDULE_ASK_LINE_RE.some((re) => re.test(n))
}

export function conversationAlreadyUsedBlockedScheduleAsk(
  messages: Array<{ author: string; text: string }>,
  isOutbound: (author: string) => boolean,
): boolean {
  return messages.some((m) => isOutbound(m.author) && lineLooksLikeBlockedScheduleAsk(m.text))
}

/** Gỡ dòng lặp câu hỏi lịch nếu salon đã hỏi trước đó. */
export function filterRepeatedBlockedScheduleAskLines(
  lines: string[],
  alreadyAsked: boolean,
): string[] {
  if (!alreadyAsked) return lines
  return lines.filter((line) => !lineLooksLikeBlockedScheduleAsk(line))
}

/** Cụm hạn ưu đãi T7/CN (tuần này / tuần sau) — tối đa 1 lần / hội thoại (KNOWLEDGE 2). */
const PROMO_DEADLINE_LINE_RE = [
  /chuong trinh uu dai.*thu 7.*chu nhat.*tuan (nay|sau)/,
  /uu dai nay.*den het thu 7.*chu nhat.*tuan (nay|sau)/,
  /den het thu 7[, ]+chu nhat.*tuan (nay|sau)/,
  /het thu 7[, ]+chu nhat.*tuan (nay|sau)/,
  /thu 7[, ]+chu nhat.*tuan (nay|sau).*(uu dai|chuong trinh)/,
  /(uu dai|chuong trinh).*(het )?thu 7.*chu nhat.*tuan (nay|sau)/,
]

export function lineLooksLikePromoDeadlineLine(line: string): boolean {
  const n = normalizeScheduleAskCheckText(line)
  if (!n) return false
  return PROMO_DEADLINE_LINE_RE.some((re) => re.test(n))
}

export function conversationAlreadyUsedPromoDeadline(
  messages: Array<{ author: string; text: string }>,
  isOutbound: (author: string) => boolean,
): boolean {
  return messages.some((m) => isOutbound(m.author) && lineLooksLikePromoDeadlineLine(m.text))
}

/**
 * Gỡ lặp hạn T7/CN: đã nói trong hội thoại → bỏ hết; trong cùng 1 lượt → giữ tối đa 1 dòng.
 */
export function filterPromoDeadlineLines(lines: string[], alreadyUsedInConversation: boolean): string[] {
  let keptInThisReply = false
  return lines.filter((line) => {
    if (!lineLooksLikePromoDeadlineLine(line)) return true
    if (alreadyUsedInConversation) return false
    if (keptInThisReply) return false
    keptInThisReply = true
    return true
  })
}

function branchById(id: number): BranchPage {
  return BRANCH_PAGES.find((b) => b.id === id) ?? BRANCH_PAGES[0]
}

/** Fanpage "Salon Tú Ka Wa" chính (không kèm tên quận/CN khác) → Bình Tân. */
function isSalonTuKaWaBinhTanMainPage(normalizedName: string): boolean {
  if (!/\bsalon\b/.test(normalizedName)) return false
  if (!/\b(tu\s*ka\s*wa|tukawa)\b/.test(normalizedName)) return false
  if (/(?:^|\s)(?:cn|chi nhanh)\s*#?\s*\d{1,2}\b/.test(normalizedName)) return false
  if (matchFanpageBranchKeywords(normalizedName)) return false
  if (matchByBranchLabelInPageName(normalizedName)) return false
  const rest = normalizedName
    .replace(/\bsalon\b/g, ' ')
    .replace(/\btoc\b/g, ' ')
    .replace(/\btu\s*ka\s*wa\b/g, ' ')
    .replace(/\btukawa\b/g, ' ')
    .replace(/\bbinh\s*tan\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return rest.length === 0
}

/** Từ khóa địa danh / tên CN — thứ tự ưu tiên từ cụ thể → chung. */
const FANPAGE_BRANCH_KEYWORDS: { id: number; keys: string[] }[] = [
  { id: 12, keys: ['trang bang', 'lang binh tong', 'tu ka wa trang bang'] },
  { id: 17, keys: ['tay ninh', 'cach mang thang 8', 'tu ka wa tay ninh'] },
  { id: 2, keys: ['binh tan', 'vanh dai trong', 'binh tri dong'] },
  { id: 1, keys: ['quan 1', 'q1', 'pham viet chanh', 'cau ong lanh'] },
  { id: 3, keys: ['hoc mon', 'le thi ha'] },
  { id: 4, keys: ['quan 12', 'nguyen anh thu'] },
  { id: 5, keys: ['go vap', 'quang trung'] },
  { id: 6, keys: ['thu duc', 'kha van can', 'linh dong'] },
  { id: 7, keys: ['tan phu', 'tan son nhi'] },
  { id: 8, keys: ['quan 9', 'man thien', 'tang nhon phu'] },
  { id: 9, keys: ['thu dau mot', 'tdm', 'dai lo binh duong', 'binh duong'] },
  { id: 10, keys: ['ben cat', 'golden centercity'] },
  { id: 11, keys: ['thuan an', 'vietsing', 'duong d1'] },
  { id: 13, keys: ['bien hoa', 'nguyen ai quoc', 'tan phong'] },
  { id: 14, keys: ['phu quoc', 'duong dong', '30 4'] },
  { id: 15, keys: ['da lat', 'phan boi chau'] },
  { id: 16, keys: ['binh phuoc', 'dong xoai', 'quoc lo 14'] },
  { id: 18, keys: ['vung tau', 'truong cong dinh'] },
  { id: 19, keys: ['nha trang', 'nguyen thi minh khai', 'khanh hoa'] },
  { id: 20, keys: ['an giang', 'rach gia', 'tran quang khai'] },
]

function matchFanpageBranchKeywords(normalizedName: string): BranchPage | null {
  const hits: { id: number; keyLen: number }[] = []
  for (const row of FANPAGE_BRANCH_KEYWORDS) {
    for (const k of row.keys) {
      if (normalizedName.includes(k)) hits.push({ id: row.id, keyLen: k.length })
    }
  }
  if (!hits.length) return null
  hits.sort((a, b) => b.keyLen - a.keyLen)
  return branchById(hits[0].id)
}

/** Khớp phần tên chi nhánh sau "CN n -" (vd "go vap", "tu ka wa trang bang"). */
function matchByBranchLabelInPageName(normalizedName: string): BranchPage | null {
  let best: { b: BranchPage; len: number } | null = null
  for (const b of BRANCH_PAGES) {
    const label = normalizeSearchText(b.name.replace(/^cn\s*\d+\s*[-–]\s*/i, ''))
    if (label.length < 4 || !normalizedName.includes(label)) continue
    if (!best || label.length > best.len) best = { b, len: label.length }
  }
  return best?.b ?? null
}

function parseCnNumberFromPageName(pageName: string): number | null {
  const m =
    pageName.match(/\bCN\s*#?\s*(\d{1,2})\b/i) ??
    pageName.match(/\bchi\s*nh[aá]nh\s*#?\s*(\d{1,2})\b/i) ??
    pageName.match(/\bCN(\d{1,2})\b/i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n) || n < 1 || n > BRANCH_PAGES.length) return null
  return n
}

/** Chi nhánh cố định theo tên fanpage (khớp CN / địa danh / tên CN trong page). */
export function inferBranchForFacebookPage(page: { id: string; name: string }, _pageOrderIndex = 0): BranchPage {
  const normalizedName = normalizeSearchText(page.name)

  const cn = parseCnNumberFromPageName(page.name)
  if (cn != null) return branchById(cn)

  const byLabel = matchByBranchLabelInPageName(normalizedName)
  if (byLabel) return byLabel

  const byKeyword = matchFanpageBranchKeywords(normalizedName)
  if (byKeyword) return byKeyword

  if (isSalonTuKaWaBinhTanMainPage(normalizedName)) return branchById(2)

  let h = 0
  for (let i = 0; i < page.id.length; i++) h = (Math.imul(31, h) + page.id.charCodeAt(i)) | 0
  const idx = Math.abs(h) % BRANCH_PAGES.length
  return BRANCH_PAGES[idx] ?? BRANCH_PAGES[0]
}
