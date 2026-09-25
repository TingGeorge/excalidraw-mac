import Foundation

/// A JSON value that round-trips exactly (keeps ints vs. doubles, bools, nulls).
public enum JSON: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let i = try? c.decode(Int.self) { self = .int(i) }
        else if let d = try? c.decode(Double.self) { self = .double(d) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSON].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .int(let i): try c.encode(i)
        case .double(let d): try c.encode(d)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    public static func parse(_ text: String) throws -> JSON {
        try JSONDecoder().decode(JSON.self, from: Data(text.utf8))
    }

    public static func parse(_ data: Data) throws -> JSON {
        try JSONDecoder().decode(JSON.self, from: data)
    }

    /// Compact single-line JSON text.
    public var text: String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        // Encoding a JSON value cannot fail (no NaN/Infinity can be parsed into one).
        return String(decoding: (try? enc.encode(self)) ?? Data("null".utf8), as: UTF8.self)
    }

    public subscript(key: String) -> JSON? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var string: String? { if case .string(let s) = self { return s }; return nil }
    public var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var object: [String: JSON]? { if case .object(let o) = self { return o }; return nil }
    public var array: [JSON]? { if case .array(let a) = self { return a }; return nil }
    public var number: Double? {
        switch self {
        case .int(let i): return Double(i)
        case .double(let d): return d
        default: return nil
        }
    }
}

extension JSON: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral, ExpressibleByNilLiteral
{
    public init(stringLiteral v: String) { self = .string(v) }
    public init(booleanLiteral v: Bool) { self = .bool(v) }
    public init(integerLiteral v: Int) { self = .int(v) }
    public init(dictionaryLiteral elements: (String, JSON)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { _, b in b }))
    }
    public init(arrayLiteral elements: JSON...) { self = .array(elements) }
    public init(nilLiteral: ()) { self = .null }
}
