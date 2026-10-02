<?php
/**
 * Plugin Name: OutSignal Image Metadata
 * Description: Добавляет creditText, copyrightNotice и creator во все ImageObject в JSON-LD
 *              (Google Search Console → «Метаданные изображений»).
 * Version: 1.0.0
 *
 * Установка: положить этот файл в wp-content/mu-plugins/.
 *
 * Работает с любым SEO-плагином (Yoast, Rank Math, AIOSEO, SEOPress, тема):
 * правит уже готовые блоки <script type="application/ld+json"> в HTML страницы.
 * Поля, которые уже заполнены, не перезаписываются.
 *
 * Значения можно переопределить в wp-config.php:
 *   define('OUTSIGNAL_IMAGE_CREDIT', 'OutSignal');
 *   define('OUTSIGNAL_IMAGE_COPYRIGHT', '© OutSignal');
 *   define('OUTSIGNAL_IMAGE_LICENSE', 'https://outsignal.com/terms/');        // необязательно
 *   define('OUTSIGNAL_IMAGE_ACQUIRE_LICENSE', 'https://outsignal.com/contact/'); // необязательно
 */

if (!defined('ABSPATH')) {
    exit;
}

function outsignal_image_metadata_fields(): array
{
    $name = defined('OUTSIGNAL_IMAGE_CREDIT') ? OUTSIGNAL_IMAGE_CREDIT : get_bloginfo('name');
    $home = function_exists('home_url') ? home_url('/') : '';

    $fields = [
        'creditText'      => $name,
        'copyrightNotice' => defined('OUTSIGNAL_IMAGE_COPYRIGHT')
            ? OUTSIGNAL_IMAGE_COPYRIGHT
            : '© ' . gmdate('Y') . ' ' . $name,
        'creator'         => array_filter(['@type' => 'Organization', 'name' => $name, 'url' => $home]),
    ];
    if (defined('OUTSIGNAL_IMAGE_LICENSE')) {
        $fields['license'] = OUTSIGNAL_IMAGE_LICENSE;
    }
    if (defined('OUTSIGNAL_IMAGE_ACQUIRE_LICENSE')) {
        $fields['acquireLicensePage'] = OUTSIGNAL_IMAGE_ACQUIRE_LICENSE;
    }
    return $fields;
}

/** Рекурсивно дополняет все узлы с @type ImageObject. */
function outsignal_image_metadata_walk($node, array $fields)
{
    if (!is_array($node)) {
        return $node;
    }
    foreach ($node as $key => $value) {
        $node[$key] = outsignal_image_metadata_walk($value, $fields);
    }
    $types = isset($node['@type']) ? (array) $node['@type'] : [];
    if (in_array('ImageObject', $types, true)) {
        foreach ($fields as $key => $value) {
            if (empty($node[$key])) {
                $node[$key] = $value;
            }
        }
    }
    return $node;
}

/** Правит все блоки JSON-LD в HTML. Невалидный JSON оставляет как есть. */
function outsignal_image_metadata_filter_html(string $html, array $fields): string
{
    return preg_replace_callback(
        '#(<script\b[^>]*type=["\']application/ld\+json["\'][^>]*>)(.*?)(</script>)#is',
        function ($m) use ($fields) {
            $data = json_decode($m[2], true);
            if (!is_array($data) || strpos($m[2], 'ImageObject') === false) {
                return $m[0];
            }
            $json = json_encode(
                outsignal_image_metadata_walk($data, $fields),
                JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
            );
            return $json === false ? $m[0] : $m[1] . $json . $m[3];
        },
        $html
    ) ?? $html;
}

add_action('template_redirect', function () {
    if (is_admin() || is_feed() || wp_doing_ajax() || (defined('REST_REQUEST') && REST_REQUEST)) {
        return;
    }
    ob_start(function ($html) {
        return is_string($html) && stripos($html, 'application/ld+json') !== false
            ? outsignal_image_metadata_filter_html($html, outsignal_image_metadata_fields())
            : $html;
    });
}, 0);
