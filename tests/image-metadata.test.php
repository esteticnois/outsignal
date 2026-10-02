<?php
// php tests/image-metadata.test.php

define('ABSPATH', __DIR__);
function add_action() {}
require __DIR__ . '/../integrations/wordpress/outsignal-image-metadata.php';

$fields = ['creditText' => 'OutSignal', 'copyrightNotice' => '© 2026 OutSignal'];
$fail = 0;
function check($name, $ok) { global $fail; echo ($ok ? 'ok   ' : 'FAIL ') . $name . "\n"; $fail += $ok ? 0 : 1; }

// Граф Yoast / Rank Math: ImageObject внутри @graph и вложенный в Article.
$html = '<head><script type="application/ld+json" class="yoast-schema-graph">'
    . '{"@context":"https://schema.org","@graph":[{"@type":"ImageObject","@id":"#primaryimage","url":"https://outsignal.com/a.jpg"},'
    . '{"@type":["Article","BlogPosting"],"image":{"@type":"ImageObject","url":"https://outsignal.com/b.jpg","creditText":"Фото: Unsplash"}}]}'
    . '</script></head>';
$out = outsignal_image_metadata_filter_html($html, $fields);
preg_match('#<script[^>]*>(.*?)</script>#s', $out, $m);
$data = json_decode($m[1], true);
check('ImageObject в @graph получил creditText', $data['@graph'][0]['creditText'] === 'OutSignal');
check('ImageObject в @graph получил copyrightNotice', $data['@graph'][0]['copyrightNotice'] === '© 2026 OutSignal');
check('вложенный ImageObject получил copyrightNotice', $data['@graph'][1]['image']['copyrightNotice'] === '© 2026 OutSignal');
check('существующий creditText не перезаписан', $data['@graph'][1]['image']['creditText'] === 'Фото: Unsplash');
check('Article не тронут', !isset($data['@graph'][1]['creditText']));
check('атрибуты тега сохранены', strpos($out, 'class="yoast-schema-graph"') !== false);
check('слэши и кириллица не экранированы', strpos($out, 'https://outsignal.com/a.jpg') !== false && strpos($out, 'Фото') !== false);

$bad = '<script type="application/ld+json">{ImageObject broken</script>';
check('невалидный JSON не тронут', outsignal_image_metadata_filter_html($bad, $fields) === $bad);
$noimg = '<script type="application/ld+json">{"@type": "Organization"}</script>';
check('блок без ImageObject не тронут', outsignal_image_metadata_filter_html($noimg, $fields) === $noimg);

exit($fail ? 1 : 0);
