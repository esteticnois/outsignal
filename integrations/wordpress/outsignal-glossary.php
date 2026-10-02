<?php
/**
 * Plugin Name: OutSignal Glossary
 * Description: Подсказки с переводом и пояснением для английских терминов в статьях.
 * Version: 1.0.0
 *
 * Установка: положить этот файл в wp-content/mu-plugins/, а папку glossary/
 * (outsignal-glossary.js, outsignal-glossary.css, glossary.json) —
 * в wp-content/mu-plugins/outsignal-glossary/.
 */

if (!defined('ABSPATH')) {
    exit;
}

add_action('wp_enqueue_scripts', function () {
    // Только на страницах записей, не на главной / в архивах.
    if (!is_singular(['post', 'page'])) {
        return;
    }
    $dir = __DIR__ . '/outsignal-glossary/';
    $url = content_url('mu-plugins/outsignal-glossary/');
    $ver = (string) filemtime($dir . 'glossary.json');

    wp_enqueue_style('outsignal-glossary', $url . 'outsignal-glossary.css', [], $ver);
    wp_enqueue_script('outsignal-glossary', $url . 'outsignal-glossary.js', [], $ver, ['strategy' => 'defer', 'in_footer' => true]);
    wp_add_inline_script(
        'outsignal-glossary',
        'window.OutSignalGlossaryConfig=' . wp_json_encode([
            'src'   => $url . 'glossary.json?v=' . $ver,
            'scope' => '.entry-content, .post-content, article',
        ]) . ';',
        'before'
    );
});
