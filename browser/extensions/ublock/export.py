from os import path, listdir, walk
import pathlib
import sys



extension_id = 'uBlock0@raymondhill.net'
current_path = path.dirname(__file__)
extension_dir = pathlib.Path(current_path)
mozbuild = open(path.join(current_path, 'moz.build'), 'w')
mozbuild.write('# -*- Mode: python; indent-tabs-mode: nil; tab-width: 40 -*-\n# vim: set filetype=python:\n\n')


for folder_index, folder in list(enumerate(walk(current_path))):
    # 0 o caminho da pasta
    # 1 as pastas da pasta
    # 2 os arquivos da pasta

    # Se a pasta estiver vazia, pular
    if(len(folder[2]) == 0):
        continue

    # mozbuild.write(f'FINAL_TARGET_FILES.features["{extension_id}"]')
    if(folder[0] == current_path):
        mozbuild.write(f'FINAL_TARGET_FILES.features["{extension_id}"] += [\n')
    else:
        current_folder = folder[0].replace(current_path + '\\', '')
        current_folder_array = current_folder.split('\\')
        mozbuild.write(f'FINAL_TARGET_FILES.features["{extension_id}"]')
        for str in current_folder_array:
            mozbuild.write(f'["{str}"]')
        mozbuild.write(' += [\n')

    files = folder[2]
    if 'moz.build' in files:
        files.remove('moz.build')

    if 'export.py' in files:
        files.remove('export.py')

    for file_index, file in enumerate(files):
        file_path = path.join(folder[0], file).replace(current_path + '\\', '').replace('\\', '/')
        if(file_index == len(folder[2]) - 1):
            mozbuild.write(f'    "{file_path}"\n]\n\n')
        else:
            mozbuild.write(f'    "{file_path}",\n')
